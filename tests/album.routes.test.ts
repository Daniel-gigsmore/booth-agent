import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore } from "../src/session/eventStore";
import { DEFAULT_SESSION } from "../src/session/sessionSettings";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";

const SECRET = "test-secret";
let server: Server;
let base: string;
let eventsDir: string;

beforeAll(() => {
  const store = new OutboxStore(createInMemoryOutboxDb());
  const add = (id: string, eventId: string, takenAt: string, composite: boolean, printed = composite) => {
    store.insertCapture({ id, eventId, source: "webcam", originalPath: `/tmp/${id}.jpg`, takenAt });
    if (composite) store.setCompositePath(id, `/tmp/${id}-print.jpg`, "4x6");
    if (printed) store.insertPrintJob({ id: `job-${id}`, captureId: id, size: "4x6", filePath: `/tmp/${id}-print.jpg` });
  };
  add("b", "evt", "2026-09-29T10:02:00.000Z", true);
  add("a", "evt", "2026-09-29T10:01:00.000Z", true);
  add("raw", "evt", "2026-09-29T10:03:00.000Z", false);
  // Composited, but the guest tapped Retake or ✕ at Review: never printed, so not in the album.
  add("rejected", "evt", "2026-09-29T10:04:00.000Z", true, false);
  add("elsewhere", "other-evt", "2026-09-29T10:00:00.000Z", true);
  eventsDir = mkdtempSync(path.join(tmpdir(), "booth-album-routes-"));
  const ctx = {
    configStore: { current: { agent: { allowedOrigins: [], sharedSecret: SECRET } } },
    events: EventStore.open(eventsDir, { id: "evt", session: DEFAULT_SESSION }),
    outboxStore: store,
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(eventsDir, { recursive: true, force: true });
});

describe("GET /album.json", () => {
  it("needs the shared secret", async () => {
    expect((await fetch(`${base}/album.json`)).status).toBe(401);
  });

  it("lists this event's composited captures, oldest first, uncached", async () => {
    const res = await fetch(`${base}/album.json?token=${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(typeof body.updatedAt).toBe("string");
    expect(body.photos).toEqual([
      { id: "a", takenAt: "2026-09-29T10:01:00.000Z" },
      { id: "b", takenAt: "2026-09-29T10:02:00.000Z" },
    ]);
  });
});

describe("GET /album/*", () => {
  it("serves the album page without the secret", async () => {
    const res = await fetch(`${base}/album/album.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("album.js");
  });

  it("serves its scripts as JavaScript", async () => {
    const res = await fetch(`${base}/album/album-logic.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("answers 404 for a missing file instead of asking for the secret", async () => {
    expect((await fetch(`${base}/album/nope.html`)).status).toBe(404);
  });

  it("never serves anything outside download/", async () => {
    const res = await fetch(`${base}/album/..%2Fpackage.json`);
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("\"name\": \"booth-agent\"");
  });
});
