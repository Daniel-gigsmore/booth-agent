import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";
import { EventStore } from "../src/session/eventStore";
import { DEFAULT_SESSION, readSessionSettings } from "../src/session/sessionSettings";

const SECRET = "test-secret";
const TOKEN = "tok-0123456789abcdef";
let dataDir: string;
let server: Server;
let base: string;

let events: EventStore;

async function start(album: { token?: string }) {
  events = EventStore.open(dataDir, { id: "gigsmore-launch-2026", name: "Gigsmore Launch", albumToken: album.token, session: DEFAULT_SESSION });
  const ctx = {
    configStore: {
      current: {
        agent: { allowedOrigins: [], sharedSecret: SECRET },
        storage: { dataDir },
        compositing: { templateDir: path.join(__dirname, "..", "assets", "templates") },
      },
    },
    events,
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const auth = { Authorization: `Bearer ${SECRET}` };
const post = (p: string, body: unknown) =>
  fetch(`${base}${p}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "booth-album-info-"));
});

afterEach(async () => {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("GET /album-info", () => {
  it("needs the shared secret", async () => {
    await start({ token: TOKEN });
    expect((await fetch(`${base}/album-info`)).status).toBe(401);
  });

  it("gives the kiosk what it needs to build the album link, and the attract setting", async () => {
    await start({ token: TOKEN });
    const res = await fetch(`${base}/album-info`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      token: TOKEN,
      eventId: "gigsmore-launch-2026",
      eventName: "Gigsmore Launch",
      attractSlideshow: true,
    });
  });

  it("reports no token when the album is off", async () => {
    await start({});
    expect((await (await fetch(`${base}/album-info`, { headers: auth })).json()).token).toBeNull();
  });
});

describe("GET /album-info, active event", () => {
  it("follows the active event", async () => {
    await start({ token: TOKEN });
    const created = events.create({ name: "TUMI", date: "2026-10-05" });
    const body = await (await fetch(`${base}/album-info`, { headers: auth })).json();
    expect(body).toMatchObject({ token: created.albumToken, eventId: "tumi-2026-10-05", eventName: "TUMI" });
  });
});

describe("POST /attract-slideshow", () => {
  it("turns the attract slideshow off and keeps the other session settings", async () => {
    await start({ token: TOKEN });
    events.updateActiveSession({ templateId: "overlay-test", firstCountdownSeconds: 5, betweenShotsSeconds: 2, attractSlideshow: true });
    const res = await post("/attract-slideshow", { enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attractSlideshow: false });
    expect(events.active().session).toEqual({
      templateId: "overlay-test",
      firstCountdownSeconds: 5,
      betweenShotsSeconds: 2,
      attractSlideshow: false,
    });
    expect((await (await fetch(`${base}/album-info`, { headers: auth })).json()).attractSlideshow).toBe(false);
  });

  it("rejects anything but a boolean", async () => {
    await start({ token: TOKEN });
    expect((await post("/attract-slideshow", { enabled: "yes" })).status).toBe(400);
    expect(events.active().session.attractSlideshow).toBe(true);
  });
});

describe("POST /session", () => {
  it("keeps the attract setting when the Settings tab doesn't send it", async () => {
    await start({ token: TOKEN });
    await post("/attract-slideshow", { enabled: false });
    const res = await post("/session", { templateId: "default-4r-grid", firstCountdownSeconds: 4, betweenShotsSeconds: 3 });
    expect(res.status).toBe(200);
    expect(events.active().session).toMatchObject({ firstCountdownSeconds: 4, attractSlideshow: false });
  });

  it("takes attractSlideshow when the body has it", async () => {
    await start({ token: TOKEN });
    await post("/attract-slideshow", { enabled: false });
    await post("/session", { templateId: "default-4r-grid", firstCountdownSeconds: 3, betweenShotsSeconds: 3, attractSlideshow: true });
    expect(events.active().session.attractSlideshow).toBe(true);
  });
});

describe("session settings", () => {
  it("default the attract slideshow to on, including for a session.json written before it existed", async () => {
    expect(readSessionSettings(dataDir).attractSlideshow).toBe(true);
    await writeFile(path.join(dataDir, "session.json"), JSON.stringify({ templateId: "x", firstCountdownSeconds: 3, betweenShotsSeconds: 3 }));
    expect(readSessionSettings(dataDir).attractSlideshow).toBe(true);
  });
});
