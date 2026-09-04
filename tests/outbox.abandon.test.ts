import { describe, it, expect } from "vitest";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";
import { SyncWorker, UploadFn } from "../src/outbox/syncWorker";
import { PermanentSyncError } from "../src/outbox/errors";
import { EventBus } from "../src/events/eventBus";
import { buildHealthReport } from "../src/health/healthReport";
import { CameraManagerStatus } from "../src/camera/CameraManager";
import { PrinterStatus } from "../src/print/printerStatus";

function makeWorker(uploadFn: UploadFn) {
  const store = new OutboxStore(createInMemoryOutboxDb());
  const worker = new SyncWorker(
    store,
    uploadFn,
    { initialBackoffMs: 5, maxBackoffMs: 20, backoffMultiplier: 2, batchSize: 100 },
    new EventBus()
  );
  return { store, worker };
}

function insert(store: OutboxStore, id: string) {
  store.insertCapture({
    id,
    eventId: "event-1",
    source: "webcam",
    originalPath: `/data/originals/${id}.jpg`,
    takenAt: new Date().toISOString(),
  });
}

const healthyCamera: CameraManagerStatus = {
  activeSource: "canon",
  activeModel: "Canon EOS R100",
  canonConnected: true,
  webcamConnected: true,
  preference: "canon",
};

const healthyPrinter: PrinterStatus = {
  reachable: true,
  ok: true,
  status: "STATUS_OK",
  model: "DS-RX1HS",
  mediaRemaining: 300,
  mediaType: "4x6",
  serialNumber: "SN1",
  lastUpdatedAt: new Date().toISOString(),
  staleMs: 100,
  error: null,
  statusFilePath: "C:\\DNP\\HotFolderPrint\\Logs\\printer_status.txt",
  raw: {},
};

describe("abandoning captures that can never sync", () => {
  it("keeps retrying a network failure forever - no attempt cap", async () => {
    let attempts = 0;
    const { store, worker } = makeWorker(async () => {
      attempts += 1;
      throw new Error("fetch failed");
    });
    insert(store, "cap-1");

    // An event's worth of offline retries must not exhaust anything: being
    // offline all night and draining afterwards is a supported state.
    for (let i = 0; i < 30; i += 1) {
      await worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(attempts).toBeGreaterThan(20);
    expect(store.getById("cap-1")?.sync_abandoned_at).toBeNull();
    expect(store.getSyncSummary().queueDepth).toBe(1);
    expect(store.getSyncSummary().abandonedCount).toBe(0);
  });

  it("abandons a capture whose file is gone, and stops attempting it", async () => {
    let attempts = 0;
    const { store, worker } = makeWorker(async (row) => {
      attempts += 1;
      throw new PermanentSyncError(`capture file is no longer readable at ${row.original_path}`);
    });
    insert(store, "cap-1");

    await worker.tick();
    expect(attempts).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await worker.tick();
    await worker.tick();
    expect(attempts).toBe(1); // never picked up again

    const row = store.getById("cap-1");
    expect(row?.sync_abandoned_at).not.toBeNull();
    expect(row?.last_error).toContain("no longer readable");
  });

  it("takes abandoned rows out of the backlog and out of lastError", async () => {
    const { store, worker } = makeWorker(async (row) => {
      if (row.id === "cap-dead") throw new PermanentSyncError("capture file is gone");
      return { storagePath: `bucket/${row.id}.jpg`, sourcePath: row.original_path };
    });
    insert(store, "cap-dead");
    insert(store, "cap-ok");
    await worker.tick();

    const summary = store.getSyncSummary();
    // The whole point: a dead capture must not hold the backlog above zero or
    // pin an error string to /health for the life of the deployment.
    expect(summary.queueDepth).toBe(0);
    expect(summary.lastError).toBeNull();
    expect(summary.abandonedCount).toBe(1);
  });

  it("reports abandoned captures as their own warn, separate from a backlog", () => {
    const report = buildHealthReport({
      camera: healthyCamera,
      hotFolder: { path: "C:\\DNP\\HotFolderPrint\\Prints", writable: true },
      printer: healthyPrinter,
      disk: { freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 },
      outbox: { queueDepth: 0, lastSyncAt: null, lastError: null, abandonedCount: 2 },
      eventId: "gigsmore-launch-2026",
      thresholds: {
        lowDiskWarnBytes: 10 * 1024 ** 3,
        lowMediaWarnPrints: 30,
        outboxBacklogWarn: 50,
        expectedMediaType: "4x6",
      },
    });

    expect(report.overall).toBe("warn");
    expect(report.alerts.map((a) => a.code)).toEqual(["outbox-abandoned"]);
  });

  it("puts abandoned rows back in the queue on request, once the files are back", async () => {
    let filesPresent = false;
    const { store, worker } = makeWorker(async (row) => {
      if (!filesPresent) throw new PermanentSyncError("capture file is gone");
      return { storagePath: `bucket/${row.id}.jpg`, sourcePath: row.original_path };
    });
    insert(store, "cap-1");
    await worker.tick();
    expect(store.getAbandoned().map((r) => r.id)).toEqual(["cap-1"]);

    // Operator remounts the drive / points dataDir back where it was.
    filesPresent = true;
    expect(store.retryAbandoned()).toBe(1);
    await worker.tick();

    expect(store.getById("cap-1")?.sync_status).toBe("synced");
    expect(store.getSyncSummary().abandonedCount).toBe(0);
  });
});
