import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";
import { EventStore } from "../src/session/eventStore";
import { DEFAULT_SESSION } from "../src/session/sessionSettings";

const SECRET = "test-secret";
const auth = { Authorization: `Bearer ${SECRET}` };
let dataDir: string;
let server: Server;
let base: string;
let events: EventStore;
let markDirty: ReturnType<typeof vi.fn>;

function start() {
  const outbox = new OutboxStore(createInMemoryOutboxDb());
  outbox.insertCapture({ id: "p1", eventId: "evt", source: "webcam", originalPath: "/tmp/p1.jpg", takenAt: "2026-09-30T10:00:00.000Z" });
  outbox.setCompositePath("p1", "/tmp/p1-print.jpg", "4x6");
  outbox.insertPrintJob({ id: "job-p1", captureId: "p1", size: "4x6", filePath: "/tmp/p1-print.jpg" });
  markDirty = vi.fn();
  const ctx = {
    configStore: { current: { agent: { allowedOrigins: [], sharedSecret: SECRET }, storage: { dataDir } } },
    outboxStore: outbox,
    album: { markDirty },
    events,
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (p: string, body?: unknown) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "booth-events-routes-"));
  events = EventStore.open(dataDir, { id: "evt", name: "Gigsmore Launch", session: DEFAULT_SESSION }, "2026-09-30");
  start();
});

afterEach(async () => {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("/events", () => {
  it("needs the shared secret", async () => {
    expect((await fetch(`${base}/events`)).status).toBe(401);
  });

  it("lists the events newest first with their printed photo counts", async () => {
    events.create({ name: "Older", date: "2026-01-01" });
    events.activate("evt");
    const res = await fetch(`${base}/events`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      activeId: "evt",
      events: [
        { id: "evt", name: "Gigsmore Launch", date: "2026-09-30", photoCount: 1 },
        { id: "older-2026-01-01", name: "Older", date: "2026-01-01", photoCount: 0 },
      ],
    });
  });

  it("creates an event and switches to it", async () => {
    const res = await post("/events", { name: "  TUMI Launch ", date: "2026-10-05" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "tumi-launch-2026-10-05", name: "TUMI Launch", date: "2026-10-05" });
    expect(events.active().id).toBe("tumi-launch-2026-10-05");
  });

  it("rejects a blank name or a bad date and stays on the current event", async () => {
    expect((await post("/events", { name: "  " })).status).toBe(400);
    expect((await post("/events", { name: "A", date: "tomorrow" })).status).toBe(400);
    expect(events.active().id).toBe("evt");
  });

  it("switches to an existing event and refreshes its album", async () => {
    events.create({ name: "TUMI", date: "2026-10-05" });
    const res = await post("/events/evt/activate");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "evt", name: "Gigsmore Launch", date: "2026-09-30" });
    expect(events.active().id).toBe("evt");
    expect(markDirty).toHaveBeenCalledWith("evt");
  });

  it("answers 404 for an unknown event", async () => {
    expect((await post("/events/nope/activate")).status).toBe(404);
  });

  it("answers 500 and changes nothing while events.json is unreadable", async () => {
    server.close();
    await writeFile(path.join(dataDir, "events.json"), "{ broken");
    events = EventStore.open(dataDir, { id: "evt", session: DEFAULT_SESSION });
    start();
    const res = await post("/events", { name: "TUMI" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/events\.json/);
    expect(events.active().id).toBe("evt");
  });

  it("deletes an event from the list and keeps its album updating", async () => {
    const test = events.create({ name: "Test", date: "2026-09-30" });
    events.activate("evt");
    const res = await post(`/events/${test.id}/delete`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: test.id });
    const list = await (await fetch(`${base}/events`, { headers: auth })).json();
    expect(list.events.map((e: { id: string }) => e.id)).toEqual(["evt"]);
    expect(events.get(test.id)?.albumToken).toBe(test.albumToken);
  });

  it("refuses to delete the active event (409) or an unknown one (404)", async () => {
    const res = await post("/events/evt/delete");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/switch/i);
    expect((await post("/events/nope/delete")).status).toBe(404);
  });

  it("answers 500 and keeps the event listed when events.json can't be written", async () => {
    const test = events.create({ name: "Test", date: "2026-09-30" });
    events.activate("evt");
    // A directory where the file should be makes the atomic rename fail.
    const file = path.join(dataDir, "events.json");
    await rm(file);
    await mkdir(file);
    const res = await post(`/events/${test.id}/delete`);
    expect(res.status).toBe(500);
    expect(events.list().map((e) => e.id)).toContain(test.id);
  });
});
