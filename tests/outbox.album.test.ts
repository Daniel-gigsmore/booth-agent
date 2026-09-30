import { describe, it, expect } from "vitest";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";
import { AlbumHooks, SyncWorker, UploadFn } from "../src/outbox/syncWorker";
import { EventBus } from "../src/events/eventBus";

function makeWorker(uploadFn: UploadFn) {
  const store = new OutboxStore(createInMemoryOutboxDb());
  const album = { dirtyMarks: 0, dirtyEvents: [] as string[], publishes: 0 };
  const hooks: AlbumHooks = {
    markDirty: (eventId: string) => { album.dirtyMarks += 1; album.dirtyEvents.push(eventId); },
    publishIfDirty: async () => { album.publishes += 1; },
  };
  const worker = new SyncWorker(
    store,
    uploadFn,
    { initialBackoffMs: 10, maxBackoffMs: 50, backoffMultiplier: 2, batchSize: 100 },
    new EventBus(),
    hooks
  );
  return { store, album, worker };
}

const uploadsSource: UploadFn = async (row) => ({
  storagePath: `evt/${row.id}.jpg`,
  sourcePath: row.composite_path ?? row.original_path,
});

function insert(store: OutboxStore, id: string, composite: boolean) {
  store.insertCapture({ id, eventId: "evt", source: "webcam", originalPath: `/tmp/${id}.jpg`, takenAt: new Date().toISOString() });
  if (composite) store.setCompositePath(id, `/tmp/${id}-print.jpg`, "4x6");
}

describe("SyncWorker album hooks", () => {
  it("marks the album dirty when a print uploads", async () => {
    const { store, album, worker } = makeWorker(uploadsSource);
    insert(store, "print", true);
    await worker.tick();
    expect(album.dirtyMarks).toBe(1);
    expect(album.dirtyEvents).toEqual(["evt"]);
  });

  it("doesn't mark it for a raw original", async () => {
    const { store, album, worker } = makeWorker(uploadsSource);
    insert(store, "raw", false);
    await worker.tick();
    expect(album.dirtyMarks).toBe(0);
  });

  it("doesn't mark it when the upload fails", async () => {
    const { store, album, worker } = makeWorker(async () => { throw new Error("offline"); });
    insert(store, "print", true);
    await worker.tick();
    expect(album.dirtyMarks).toBe(0);
  });

  it("gives the album a chance to publish on every tick, even an idle one", async () => {
    const { album, worker } = makeWorker(uploadsSource);
    await worker.tick();
    await worker.tick();
    expect(album.publishes).toBe(2);
  });

  it("keeps syncing when the album throws", async () => {
    const store = new OutboxStore(createInMemoryOutboxDb());
    const hooks: AlbumHooks = {
      markDirty: (_eventId: string) => {},
      publishIfDirty: async () => { throw new Error("album backend down"); },
    };
    const worker = new SyncWorker(
      store,
      uploadsSource,
      { initialBackoffMs: 10, maxBackoffMs: 50, backoffMultiplier: 2, batchSize: 100 },
      new EventBus(),
      hooks
    );
    insert(store, "print", true);
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(store.getSyncSummary().queueDepth).toBe(0);
  });
});
