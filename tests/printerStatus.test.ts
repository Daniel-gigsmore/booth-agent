import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readPrinterStatus,
  defaultPrinterStatusPath,
} from "../src/print/printerStatus";
import { buildHealthReport } from "../src/health/healthReport";

const STALE_AFTER_MS = 120_000;

let dir: string;
let statusFile: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-printer-status-"));
  statusFile = path.join(dir, "printer_status.txt");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(content: string, ageMs = 0): Promise<void> {
  await writeFile(statusFile, content, "utf8");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(statusFile, when, when);
  }
}

describe("defaultPrinterStatusPath", () => {
  it("derives Logs/printer_status.txt as a sibling of the Prints folder", () => {
    const derived = defaultPrinterStatusPath(
      path.join("C:", "DNP", "HotFolderPrint", "Prints")
    );
    expect(derived).toBe(
      path.join("C:", "DNP", "HotFolderPrint", "Logs", "printer_status.txt")
    );
  });
});

describe("readPrinterStatus", () => {
  it("reports a healthy printer with its model and remaining media", async () => {
    await write(
      JSON.stringify({
        Status: "STATUS_OK",
        Model: "DS-RX1HS",
        MediaRemaining: 412,
      })
    );

    const status = await readPrinterStatus({
      statusFilePath: statusFile,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(status.reachable).toBe(true);
    expect(status.ok).toBe(true);
    expect(status.status).toBe("STATUS_OK");
    expect(status.model).toBe("DS-RX1HS");
    expect(status.mediaRemaining).toBe(412);
    expect(status.error).toBeNull();
  });

  it("reports a printer that is present but not OK - the paper-out case", async () => {
    await write(JSON.stringify({ Status: "STATUS_PAPER_OUT", Model: "DS-RX1HS" }));

    const status = await readPrinterStatus({
      statusFilePath: statusFile,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(status.reachable).toBe(true);
    expect(status.ok).toBe(false);
    expect(status.status).toBe("STATUS_PAPER_OUT");
  });

  /**
   * The single most important case in this file. A force-killed
   * HotFolderPrint.exe leaves its last STATUS_OK on disk indefinitely - if the
   * reader trusted content alone, a dead print pipeline would report perfect
   * health for the rest of the event.
   */
  it("refuses to trust a stale STATUS_OK left behind by a dead HFP process", async () => {
    await write(JSON.stringify({ Status: "STATUS_OK" }), STALE_AFTER_MS * 3);

    const status = await readPrinterStatus({
      statusFilePath: statusFile,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(status.reachable).toBe(false);
    expect(status.ok).toBe(false);
    expect(status.error).toMatch(/stale/i);
    expect(status.staleMs).toBeGreaterThan(STALE_AFTER_MS);
  });

  it("treats a missing status file as unreachable, not as healthy", async () => {
    const status = await readPrinterStatus({
      statusFilePath: path.join(dir, "does-not-exist.txt"),
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(status.reachable).toBe(false);
    expect(status.error).toMatch(/not found/i);
  });

  it("survives an unexpected file shape and passes the raw JSON through for diagnosis", async () => {
    await write(JSON.stringify({ SomeFutureKey: "who knows" }));

    const status = await readPrinterStatus({
      statusFilePath: statusFile,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(status.reachable).toBe(false);
    expect(status.error).toMatch(/no recognised status field/i);
    expect(status.raw).toEqual({ SomeFutureKey: "who knows" });
  });

  it("tolerates key casing/spacing variants and an array of printers", async () => {
    await write(
      JSON.stringify([{ "printer status": "status_ok", "Printer Name": "DS-RX1HS" }])
    );

    const status = await readPrinterStatus({
      statusFilePath: statusFile,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(status.ok).toBe(true);
    expect(status.model).toBe("DS-RX1HS");
  });
});

describe("readPrinterStatus against the real booth PC file shape", () => {
  /**
   * Captured verbatim from C:\\DNP\\HotFolderPrint\\Logs\\printer_status.txt on
   * the booth PC. Pinning the real shape means a future HFP update that
   * changes it fails here rather than at the booth.
   */
  it("parses the actual DS-RX1HS status file", async () => {
    await write(
      JSON.stringify([
        {
          Name: "RX1HS-1",
          Model: "RX1HS",
          Status: "STATUS_OK",
          MediaType: "4x6",
          MediaRemaining: 687,
          LifeCounter: 10,
          SerialNumber: "CB2D63218295",
          FirmwareVersion: "DS-RX1 02.21",
          ColorDataVersion: "DS-RX1_300_0201.CWD",
        },
      ])
    );

    const status = await readPrinterStatus({
      statusFilePath: statusFile,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(status.ok).toBe(true);
    expect(status.model).toBe("RX1HS");
    expect(status.mediaType).toBe("4x6");
    expect(status.mediaRemaining).toBe(687);
    expect(status.serialNumber).toBe("CB2D63218295");
  });
});

describe("buildHealthReport print severity", () => {
  const baseInputs = {
    camera: {
      activeSource: "canon" as const,
      activeModel: "Canon EOS R100",
      canonConnected: true,
      webcamConnected: true,
      preference: "canon" as const,
    },
    hotFolder: { path: "C:\\DNP\\HotFolderPrint\\Prints", writable: true },
    disk: { freeBytes: 200 * 1024 ** 3, totalBytes: 512 * 1024 ** 3 },
    outbox: { queueDepth: 0, lastSyncAt: null, lastError: null },
    eventId: "gigsmore-launch-2026",
    thresholds: {
      lowDiskWarnBytes: 10 * 1024 ** 3,
      lowMediaWarnPrints: 30,
      outboxBacklogWarn: 50,
      expectedMediaType: "4x6",
    },
  };

  const healthyPrinter = {
    reachable: true,
    ok: true,
    status: "STATUS_OK",
    model: "DS-RX1HS",
    mediaRemaining: 400,
    mediaType: "4x6",
    serialNumber: "CB2D63218295",
    lastUpdatedAt: new Date().toISOString(),
    staleMs: 0,
    error: null,
    statusFilePath: "printer_status.txt",
    raw: {},
  };

  it("is green when everything is fine", () => {
    const report = buildHealthReport({ ...baseInputs, printer: healthyPrinter });
    expect(report.overall).toBe("ok");
    expect(report.alerts).toHaveLength(0);
  });

  it("goes red when the printer is not OK even though the hot folder is writable", () => {
    const report = buildHealthReport({
      ...baseInputs,
      printer: { ...healthyPrinter, ok: false, status: "STATUS_PAPER_OUT" },
    });
    expect(report.overall).toBe("error");
    expect(report.alerts.map((a) => a.code)).toContain("printer-not-ok");
  });

  it("warns before the roll runs out rather than after", () => {
    const report = buildHealthReport({
      ...baseInputs,
      printer: { ...healthyPrinter, mediaRemaining: 12 },
    });
    expect(report.overall).toBe("warn");
    expect(report.alerts.map((a) => a.code)).toContain("media-low");
  });

  /**
   * Wrong media is invisible everywhere else in the pipeline: the copy
   * succeeds, HFP accepts the file, and the print is simply wrong.
   */
  it("goes red when the loaded media does not match what templates expect", () => {
    const report = buildHealthReport({
      ...baseInputs,
      printer: { ...healthyPrinter, mediaType: "5x7" },
    });
    expect(report.overall).toBe("error");
    expect(report.alerts.map((a) => a.code)).toContain("media-type-mismatch");
  });

  /**
   * Being offline is a designed-for, guest-invisible state. Escalating it to
   * red would train the operator to ignore red on the one night it matters.
   */
  it("keeps a large upload backlog at warn, never error", () => {
    const report = buildHealthReport({
      ...baseInputs,
      printer: healthyPrinter,
      outbox: { queueDepth: 300, lastSyncAt: null, lastError: "network down" },
    });
    expect(report.overall).toBe("warn");
    expect(report.alerts.map((a) => a.code)).toContain("outbox-backlog");
  });
});
