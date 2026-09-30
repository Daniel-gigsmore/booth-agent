import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore } from "../src/session/eventStore";
import { DEFAULT_SESSION } from "../src/session/sessionSettings";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";

/** A capture at each stage: composited or not, printed or not, composite uploaded or not. */
function store() {
  const s = new OutboxStore(createInMemoryOutboxDb());
  const add = (id: string, at: string, o: { composite?: boolean; printed?: boolean; uploaded?: "original" | "composite"; event?: string }) => {
    s.insertCapture({ id, eventId: o.event ?? "evt", source: "webcam", originalPath: `/tmp/${id}.jpg`, takenAt: at });
    if (o.composite) s.setCompositePath(id, `/tmp/${id}-print.jpg`, "4x6");
    if (o.printed) s.insertPrintJob({ id: `job-${id}`, captureId: id, size: "4x6", filePath: `/tmp/${id}-print.jpg` });
    if (o.uploaded) s.markSynced(id, `evt/${id}.jpg`, o.uploaded === "composite" ? `/tmp/${id}-print.jpg` : `/tmp/${id}.jpg`);
  };
  add("done-b", "2026-09-29T10:02:00.000Z", { composite: true, printed: true, uploaded: "composite" });
  add("done-a", "2026-09-29T10:01:00.000Z", { composite: true, printed: true, uploaded: "composite" });
  add("rejected", "2026-09-29T10:03:00.000Z", { composite: true, uploaded: "composite" });
  add("printing", "2026-09-29T10:04:00.000Z", { composite: true, printed: true });
  add("printed-raw-up", "2026-09-29T10:05:00.000Z", { composite: true, printed: true, uploaded: "original" });
  add("elsewhere", "2026-09-29T10:00:00.000Z", { composite: true, printed: true, uploaded: "composite", event: "other" });
  return s;
}

describe("OutboxStore.listPublishedPrints", () => {
  it("lists only this event's printed captures whose print is in Supabase, oldest first", () => {
    expect(store().listPublishedPrints("evt")).toEqual([
      { id: "done-a", takenAt: "2026-09-29T10:01:00.000Z" },
      { id: "done-b", takenAt: "2026-09-29T10:02:00.000Z" },
    ]);
  });
});

let server: Server | undefined;
let eventsDir: string | undefined;
afterEach(() => {
  server?.close();
  if (eventsDir) rmSync(eventsDir, { recursive: true, force: true });
});

describe("POST /print", () => {
  it("marks the album dirty, so a print whose composite uploaded first still gets listed", async () => {
    const outbox = store();
    let dirty = 0;
    eventsDir = mkdtempSync(path.join(tmpdir(), "booth-album-printed-"));
    const ctx = {
      configStore: { current: { agent: { allowedOrigins: [], sharedSecret: "s" }, printing: { defaultSize: "4x6" } } },
      events: EventStore.open(eventsDir, { id: "evt", session: DEFAULT_SESSION }),
      outboxStore: outbox,
      printQueue: { enqueue: () => ({ jobId: "j1", queuePosition: 1, estimatedWaitMs: 0 }) },
      album: { markDirty: () => { dirty += 1; } },
    } as unknown as AgentContext;
    server = buildHttpApp(ctx).listen(0);
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/print`, {
      method: "POST",
      headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
      body: JSON.stringify({ captureId: "rejected" }),
    });
    expect(res.status).toBe(202);
    expect(dirty).toBe(1);
  });
});
