import { describe, it, expect } from "vitest";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";
import { SyncWorker, UploadFn } from "../src/outbox/syncWorker";
import { EventBus } from "../src/events/eventBus";

/**
 * The regression these cover: `/capture` inserts the row and the sync worker
 * can claim it within a tick or two, which online is long before the guest has
 * picked a template and `/composite` has produced the print-ready image. The
 * old "is sync_status 'synced'?" test declared the row finished at that
 * moment, so the branded composite and its print_size never reached Supabase
 * on any capture taken with a working network - only the raw original did.
 *
 * It passed every existing test because the offline suite drains the queue
 * after compositing, which is the one ordering where the old logic was right.
 */
function setup() {
  const store = new OutboxStore(createInMemoryOutboxDb());
  const uploads: Array<{ id: string; sourcePath: string }> = [];
  const uploadFn: UploadFn = async (row) => {
    const sourcePath = row.composite_path ?? row.original_path;
    uploads.push({ id: row.id, sourcePath });
    return { storagePath: `${row.event_id}/${row.id}.jpg`, sourcePath };
  };
  const worker = new SyncWorker(
    store,
    uploadFn,
    { initialBackoffMs: 10, maxBackoffMs: 50, backoffMultiplier: 2, batchSize: 100 },
    new EventBus()
  );
  return { store, worker, uploads };
}

function insert(store: OutboxStore, id: string) {
  store.insertCapture({
    id,
    eventId: "event-1",
    source: "canon",
    originalPath: `/data/originals/${id}.jpg`,
    takenAt: new Date().toISOString(),
  });
}

describe("composite reaches Supabase regardless of sync ordering", () => {
  it("re-uploads a capture that synced as its original before /composite ran", async () => {
    const { store, worker, uploads } = setup();
    insert(store, "cap-1");

    // Online: the sync worker gets there first and pushes the raw original.
    await worker.tick();
    expect(uploads).toEqual([{ id: "cap-1", sourcePath: "/data/originals/cap-1.jpg" }]);
    expect(store.getById("cap-1")?.sync_status).toBe("synced");

    // The guest picks a template seconds later.
    store.setCompositePath("cap-1", "/data/composites/composite-1.jpg", "2x6-strip");

    // The row is owed another upload: what's in Storage is not what we'd send.
    expect(store.getSyncSummary().queueDepth).toBe(1);

    await worker.tick();
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toEqual({ id: "cap-1", sourcePath: "/data/composites/composite-1.jpg" });
    expect(store.getById("cap-1")?.synced_source_path).toBe("/data/composites/composite-1.jpg");
    expect(store.getSyncSummary().queueDepth).toBe(0);
  });

  it("settles: once the composite is up, further ticks upload nothing", async () => {
    const { store, worker, uploads } = setup();
    insert(store, "cap-1");
    await worker.tick();
    store.setCompositePath("cap-1", "/data/composites/composite-1.jpg", "4x6");
    await worker.tick();

    const callsAfterComposite = uploads.length;
    await worker.tick();
    await worker.tick();
    expect(uploads).toHaveLength(callsAfterComposite);
  });

  it("uploads only once when compositing happens before the first sync (the offline path)", async () => {
    const { store, worker, uploads } = setup();
    insert(store, "cap-1");
    store.setCompositePath("cap-1", "/data/composites/composite-1.jpg", "4x6");

    await worker.tick();
    await worker.tick();

    expect(uploads).toEqual([{ id: "cap-1", sourcePath: "/data/composites/composite-1.jpg" }]);
  });

  it("picks up a re-composite (different template) after the first composite synced", async () => {
    const { store, worker, uploads } = setup();
    insert(store, "cap-1");
    store.setCompositePath("cap-1", "/data/composites/first.jpg", "4x6");
    await worker.tick();

    store.setCompositePath("cap-1", "/data/composites/second.jpg", "2x6-strip");
    await worker.tick();

    expect(uploads.map((u) => u.sourcePath)).toEqual([
      "/data/composites/first.jpg",
      "/data/composites/second.jpg",
    ]);
  });

  it("does not re-queue a capture that was never composited", async () => {
    const { store, worker, uploads } = setup();
    insert(store, "cap-1");
    await worker.tick();
    await worker.tick();
    expect(uploads).toHaveLength(1);
    expect(store.getSyncSummary().queueDepth).toBe(0);
  });

  it("survives the composite landing while the original's upload is in flight", async () => {
    const store = new OutboxStore(createInMemoryOutboxDb());
    const uploads: string[] = [];
    let openGate = (): void => undefined;
    // Holds the FIRST upload open so the composite can land mid-flight. That
    // is the race that makes flipping sync_status inside setCompositePath
    // unsafe: markSynced() lands afterwards and silently undoes the re-queue.
    let gate: Promise<void> | null = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const uploadFn: UploadFn = async (row) => {
      const sourcePath = row.composite_path ?? row.original_path;
      if (gate) {
        const waiting = gate;
        gate = null;
        await waiting;
      }
      uploads.push(sourcePath);
      return { storagePath: `${row.event_id}/${row.id}.jpg`, sourcePath };
    };
    const worker = new SyncWorker(
      store,
      uploadFn,
      { initialBackoffMs: 10, maxBackoffMs: 50, backoffMultiplier: 2, batchSize: 100 },
      new EventBus()
    );

    insert(store, "cap-1");
    const inFlight = worker.tick();
    store.setCompositePath("cap-1", "/data/composites/composite-1.jpg", "4x6");
    openGate();
    await inFlight;

    // The original went up, and markSynced recorded that - not the composite
    // that appeared while it was in the air.
    expect(uploads).toEqual(["/data/originals/cap-1.jpg"]);

    await worker.tick();
    expect(uploads).toContain("/data/composites/composite-1.jpg");
    expect(store.getSyncSummary().queueDepth).toBe(0);
  });
});
