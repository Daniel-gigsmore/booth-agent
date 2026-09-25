import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInMemoryOutboxDb, openOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";
import { reconcileHotFolderDrops, NO_STALLED_PRINTS } from "../src/print/hotFolderStall";
import { buildHealthReport } from "../src/health/healthReport";
import { CameraManagerStatus } from "../src/camera/CameraManager";
import { PrinterStatus } from "../src/print/printerStatus";

/**
 * The failure this guards against is the one where every other signal stays
 * green: the copy into the hot folder succeeds, HFP keeps its status file
 * warm so the printer reports STATUS_OK, print-completed fires off a timer so
 * the kiosk tells the guest their photo is ready - and nothing comes out.
 */
let dir: string;
let store: OutboxStore;
let db: ReturnType<typeof createInMemoryOutboxDb>;

const MINUTE = 60_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "booth-hotfolder-"));
  db = createInMemoryOutboxDb();
  store = new OutboxStore(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Drops a job the way printQueue does: the composite stays in data\composites
 * (it is kept for reprints and sync) and a copy lands in the hot folder under
 * the job id. Returns the hot-folder copy - the file HFP consumes.
 */
function drop(id: string, droppedMinutesAgo: number, now: Date): string {
  const compositePath = path.join(dir, `composite-${id}.jpg`);
  writeFileSync(compositePath, "jpeg");
  mkdirSync(path.join(dir, "s4x6"), { recursive: true });
  const droppedPath = path.join(dir, "s4x6", `${id}.jpg`);
  writeFileSync(droppedPath, "jpeg");
  store.insertCapture({
    id: `cap-${id}`,
    eventId: "event-1",
    source: "canon",
    originalPath: path.join(dir, `${id}-original.jpg`),
    takenAt: now.toISOString(),
  });
  store.insertPrintJob({ id, captureId: `cap-${id}`, size: "4x6", filePath: compositePath });
  store.markPrintDropped(id, droppedPath);
  // markPrintDropped stamps "now"; back-date it here rather than adding a
  // test-only parameter to the production API.
  db.prepare(`UPDATE print_jobs SET dropped_at = ? WHERE id = ?`).run(
    new Date(now.getTime() - droppedMinutesAgo * MINUTE).toISOString(),
    id
  );
  return droppedPath;
}

describe("detecting a hot folder that has stopped being drained", () => {
  it("reports nothing when there are no dropped jobs at all", async () => {
    expect(await reconcileHotFolderDrops(store, 120)).toEqual(NO_STALLED_PRINTS);
  });

  it("does not flag a file that was just dropped", async () => {
    const now = new Date();
    drop("job-1", 0, now);
    expect((await reconcileHotFolderDrops(store, 120, now)).count).toBe(0);
  });

  it("flags a file still sitting there past the threshold", async () => {
    const now = new Date();
    drop("job-1", 5, now);

    const stalled = await reconcileHotFolderDrops(store, 120, now);
    expect(stalled.count).toBe(1);
    expect(stalled.oldestAgeSeconds).toBe(300);
    expect(stalled.files).toEqual([path.join(dir, "s4x6", "job-1.jpg")]);
  });

  it("treats a vanished file as claimed by HFP, which is the only honest evidence", async () => {
    const now = new Date();
    const filePath = drop("job-1", 5, now);
    unlinkSync(filePath); // HFP consumes a file by moving it

    expect((await reconcileHotFolderDrops(store, 120, now)).count).toBe(0);
    expect(store.getPrintJobById("job-1")?.consumed_at).not.toBeNull();
  });

  it("stops stat-ing a job once it is confirmed consumed", async () => {
    const now = new Date();
    const filePath = drop("job-1", 5, now);
    unlinkSync(filePath);
    await reconcileHotFolderDrops(store, 120, now);

    expect(store.getUnconsumedDroppedPrintJobs()).toHaveLength(0);

    // Even if a file reappears at that path later, the job is settled - this
    // is what keeps /health from re-checking every print for the whole event.
    writeFileSync(filePath, "jpeg");
    expect((await reconcileHotFolderDrops(store, 120, now)).count).toBe(0);
  });

  it("reports the oldest first when several are stuck", async () => {
    const now = new Date();
    drop("job-new", 3, now);
    drop("job-old", 30, now);
    drop("job-mid", 10, now);

    const stalled = await reconcileHotFolderDrops(store, 120, now);
    expect(stalled.count).toBe(3);
    expect(stalled.oldestAgeSeconds).toBe(1800);
    expect(stalled.files[0]).toBe(path.join(dir, "s4x6", "job-old.jpg"));
  });

  it("separates the drained from the stuck in the same pass", async () => {
    const now = new Date();
    const drained = drop("job-ok", 5, now);
    drop("job-stuck", 5, now);
    unlinkSync(drained);

    const stalled = await reconcileHotFolderDrops(store, 120, now);
    expect(stalled.count).toBe(1);
    expect(stalled.files).toEqual([path.join(dir, "s4x6", "job-stuck.jpg")]);
    expect(store.getPrintJobById("job-ok")?.consumed_at).not.toBeNull();
    expect(store.getPrintJobById("job-stuck")?.consumed_at).toBeNull();
  });

  // Regression: the check used to stat file_path, which is the composite in
  // data\composites. That file is kept on purpose, so every print that HFP
  // had already printed was reported as stalled once it passed the threshold.
  it("does not flag a print just because its composite is still on disk", async () => {
    const now = new Date();
    const droppedPath = drop("job-1", 5, now);
    unlinkSync(droppedPath); // HFP claimed the hot-folder copy

    const compositePath = store.getPrintJobById("job-1")!.file_path;
    expect(existsSync(compositePath)).toBe(true);

    expect((await reconcileHotFolderDrops(store, 120, now)).count).toBe(0);
    expect(store.getPrintJobById("job-1")?.consumed_at).not.toBeNull();
  });

  it("settles a dropped job with no recorded hot-folder path instead of flagging it", async () => {
    const now = new Date();
    drop("job-legacy", 5, now);
    db.prepare(`UPDATE print_jobs SET dropped_path = NULL WHERE id = ?`).run("job-legacy");

    expect((await reconcileHotFolderDrops(store, 120, now)).count).toBe(0);
    expect(store.getUnconsumedDroppedPrintJobs()).toHaveLength(0);
  });
});

describe("upgrading a booth PC whose outbox predates dropped_path", () => {
  it("settles old dropped jobs so they stop showing as stalled", () => {
    const dataDir = path.join(dir, "data");
    const first = openOutboxDb(dataDir, "outbox.db");
    const firstStore = new OutboxStore(first);
    firstStore.insertCapture({
      id: "cap-old",
      eventId: "event-1",
      source: "canon",
      originalPath: path.join(dir, "old-original.jpg"),
      takenAt: new Date().toISOString(),
    });
    // What an older agent left behind: dropped, never confirmed, and only the
    // composite path on record.
    first
      .prepare(
        `INSERT INTO print_jobs (id, capture_id, size, file_path, status, dropped_at)
         VALUES ('job-old', 'cap-old', '4x6', ?, 'dropped', '2026-09-15T08:27:13.470Z')`
      )
      .run(path.join(dir, "composite-old.jpg"));
    first.close();

    const second = openOutboxDb(dataDir, "outbox.db");
    const reopened = new OutboxStore(second);
    try {
      expect(reopened.getUnconsumedDroppedPrintJobs()).toHaveLength(0);
      expect(reopened.getPrintJobById("job-old")?.consumed_at).toBe("2026-09-15T08:27:13.470Z");
    } finally {
      // Windows keeps the file locked while open, which breaks afterEach's rmSync.
      second.close();
    }
  });
});

describe("the stall alert", () => {
  const healthyCamera: CameraManagerStatus = {
    activeSource: "canon",
    activeModel: "Canon EOS R100",
    canonConnected: true,
    webcamConnected: true,
    preference: "canon",
    canonDetail: null,
  };

  // Everything HFP reports is fine. That is the entire point of this alert.
  const healthyPrinter: PrinterStatus = {
    reachable: true,
    ok: true,
    status: "STATUS_OK",
    model: "DS-RX1HS",
    mediaRemaining: 573,
    mediaType: "4x6",
    serialNumber: "SN1",
    lastUpdatedAt: new Date().toISOString(),
    staleMs: 100,
    error: null,
    statusFilePath: "C:\\DNP\\HotFolderPrint\\Logs\\printer_status.txt",
    raw: {},
  };

  function report(stalledPrints: Parameters<typeof buildHealthReport>[0]["stalledPrints"]) {
    return buildHealthReport({
      camera: healthyCamera,
      canon: { driver: "digicamcontrol", digiCamControlRunning: false },
      hotFolder: { path: "C:\\DNP\\HotFolderPrint\\Prints", writable: true },
      stalledPrints,
      printer: healthyPrinter,
      disk: { freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 },
      outbox: { queueDepth: 0, lastSyncAt: null, lastError: null, abandonedCount: 0 },
      eventId: "gigsmore-launch-2026",
      thresholds: {
        lowDiskWarnBytes: 10 * 1024 ** 3,
        lowMediaWarnPrints: 30,
        outboxBacklogWarn: 50,
        expectedMediaType: "4x6",
      },
    });
  }

  it("is an error, because guests are being affected right now", () => {
    const result = report({
      count: 3,
      oldestDroppedAt: new Date().toISOString(),
      oldestAgeSeconds: 300,
      files: ["C:\\DNP\\HotFolderPrint\\Prints\\s4x6\\b0615ad9.jpg"],
    });

    expect(result.overall).toBe("error");
    expect(result.alerts.map((a) => a.code)).toContain("hot-folder-stalled");
  });

  it("fires even when the hot folder is writable and the printer says STATUS_OK", () => {
    const result = report({
      count: 1,
      oldestDroppedAt: new Date().toISOString(),
      oldestAgeSeconds: 240,
      files: ["f3aa792f.jpg"],
    });

    // No other check has anything to say - which is exactly how this failure
    // used to go unnoticed until a guest complained.
    expect(result.alerts.map((a) => a.code)).toEqual(["hot-folder-stalled"]);
  });

  it("stays quiet when nothing is stuck", () => {
    expect(report(NO_STALLED_PRINTS).overall).toBe("ok");
  });
});
