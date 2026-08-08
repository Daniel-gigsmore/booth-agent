import { describe, it, expect } from "vitest";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";
import { SyncWorker } from "../src/outbox/syncWorker";
import { EventBus } from "../src/events/eventBus";
import { CaptureRow } from "../src/outbox/types";

function makeWorker(uploadFn: (row: CaptureRow) => Promise<{ storagePath: string }>) {
  const db = createInMemoryOutboxDb();
  const store = new OutboxStore(db);
  const eventBus = new EventBus();
  const worker = new SyncWorker(
    store,
    uploadFn,
    { initialBackoffMs: 10, maxBackoffMs: 50, backoffMultiplier: 2, batchSize: 100 },
    eventBus
  );
  return { db, store, eventBus, worker };
}

function insertCaptures(store: OutboxStore, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `capture-${i}`;
    store.insertCapture({
      id,
      eventId: "event-1",
      source: "webcam",
      originalPath: `/tmp/${id}.jpg`,
      takenAt: new Date().toISOString(),
    });
    ids.push(id);
  }
  return ids;
}

describe("SyncWorker offline -> online", () => {
  it("queues captures while offline and leaves them pending sync", async () => {
    let online = false;
    const { store, worker } = makeWorker(async (row) => {
      if (!online) throw new Error("network unreachable");
      return { storagePath: `bucket/${row.id}.jpg` };
    });

    insertCaptures(store, 3);
    await worker.tick();

    const summary = store.getSyncSummary();
    expect(summary.queueDepth).toBe(3);
    expect(summary.lastSyncAt).toBeNull();
    expect(summary.lastError).toContain("network unreachable");
  });

  it("uploads everything once back online, with no duplicate uploads", async () => {
    let online = false;
    let uploadCalls = 0;
    const uploaded: string[] = [];
    const { store, worker } = makeWorker(async (row) => {
      uploadCalls += 1;
      if (!online) throw new Error("network unreachable");
      uploaded.push(row.id);
      return { storagePath: `bucket/${row.id}.jpg` };
    });

    const ids = insertCaptures(store, 20);

    // Simulate 20 captures taken while offline.
    await worker.tick();
    expect(store.getSyncSummary().queueDepth).toBe(20);

    // Network comes back; wait past the (short) backoff window and retry.
    online = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await worker.tick();

    const summary = store.getSyncSummary();
    expect(summary.queueDepth).toBe(0);
    expect(uploaded.sort()).toEqual([...ids].sort());
    expect(new Set(uploaded).size).toBe(20); // no duplicates

    // Further ticks must not re-upload already-synced captures.
    const callsAfterSync = uploadCalls;
    await worker.tick();
    expect(uploadCalls).toBe(callsAfterSync);
  });

  it("resumes cleanly after a crash mid-upload without re-uploading synced rows", async () => {
    let uploadCalls = 0;
    const { store, worker } = makeWorker(async (row) => {
      uploadCalls += 1;
      return { storagePath: `bucket/${row.id}.jpg` };
    });

    const [firstId] = insertCaptures(store, 1);
    await worker.tick();
    expect(store.getById(firstId!)?.sync_status).toBe("synced");
    expect(uploadCalls).toBe(1);

    // Simulate a crash that left a *different* capture stuck mid-upload.
    store.insertCapture({
      id: "capture-crashed",
      eventId: "event-1",
      source: "canon",
      originalPath: "/tmp/capture-crashed.jpg",
      takenAt: new Date().toISOString(),
    });
    store.markUploading("capture-crashed");

    // "Restart": a fresh worker over the same store resets stuck uploads and resyncs only that row.
    const eventBus = new EventBus();
    const restarted = new SyncWorker(
      store,
      async (row) => {
        uploadCalls += 1;
        return { storagePath: `bucket/${row.id}.jpg` };
      },
      { initialBackoffMs: 10, maxBackoffMs: 50, backoffMultiplier: 2, batchSize: 10 },
      eventBus
    );
    const resetCount = store.resetStuckUploads();
    expect(resetCount).toBe(1);
    await restarted.tick();

    expect(store.getById("capture-crashed")?.sync_status).toBe("synced");
    expect(store.getById(firstId!)?.sync_status).toBe("synced");
    expect(uploadCalls).toBe(2); // the already-synced capture was never retried
  });

  it("backs off exponentially and does not hammer the network every tick", async () => {
    const attemptTimestamps: number[] = [];
    const { store, worker } = makeWorker(async () => {
      attemptTimestamps.push(Date.now());
      throw new Error("still offline");
    });

    insertCaptures(store, 1);
    await worker.tick();
    await worker.tick(); // immediately again: backoff should skip this row
    expect(attemptTimestamps.length).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.tick(); // backoff window elapsed: retried
    expect(attemptTimestamps.length).toBe(2);
  });
});
