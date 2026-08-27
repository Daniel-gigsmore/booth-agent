import { CameraManagerStatus } from "../camera/CameraManager";
import { PrinterStatus } from "../print/printerStatus";
import { DiskSpace } from "../util/disk";
import { SyncSummary } from "../outbox/types";

/**
 * `/health` used to return raw facts and leave the judgement to whoever read
 * it - which in practice meant nobody made the judgement at all. The tray
 * script had its own opinion, the kiosk UI had none, and a paper-out printer
 * showed up as a perfectly green agent.
 *
 * This module is the single place that decides what "bad" means. Everything
 * that displays status (tray, kiosk, a phone hitting /health over the venue
 * wifi) reads `overall` and `alerts` instead of re-deriving it.
 *
 * The severity split is written for one specific reader: an operator glancing
 * at a tray icon between guests.
 *   error - guests are being affected right now, stop and fix it
 *   warn  - will become an error if ignored, deal with it at the next gap
 *   ok    - carry on
 * Anything that cannot become an error is not an alert. Alert fatigue is a
 * real failure mode at a four-hour event: the second time an operator sees a
 * warning they cannot act on, they stop reading warnings entirely.
 */
export type HealthLevel = "ok" | "warn" | "error";

export interface HealthAlert {
  level: Exclude<HealthLevel, "ok">;
  /** Stable machine-readable key, safe to switch on in the UI. */
  code: string;
  /** Written for a human standing at the booth, not for a log reader. */
  message: string;
}

export interface HealthThresholds {
  /** Below this, prints and captures are at risk of failing on write. */
  lowDiskWarnBytes: number;
  /** Prints left on the roll before the operator should fetch a spare. */
  lowMediaWarnPrints: number;
  /** Outbox backlog that suggests sync is not keeping up, not just offline. */
  outboxBacklogWarn: number;
  /** Media size the templates are built for, e.g. "4x6". */
  expectedMediaType: string;
}

export interface HealthInputs {
  camera: CameraManagerStatus;
  hotFolder: { path: string; writable: boolean };
  printer: PrinterStatus;
  disk: DiskSpace | null;
  outbox: SyncSummary;
  eventId: string;
  thresholds: HealthThresholds;
}

export interface HealthReport {
  overall: HealthLevel;
  alerts: HealthAlert[];
  eventId: string;
  camera: {
    activeSource: string;
    model: string | null;
    canonConnected: boolean;
    webcamConnected: boolean;
    preference: string;
  };
  hotFolder: { path: string; writable: boolean };
  printer: PrinterStatus;
  disk: DiskSpace | null;
  outbox: SyncSummary;
  timestamp: string;
}

export function buildHealthReport(inputs: HealthInputs): HealthReport {
  const { camera, hotFolder, printer, disk, outbox, eventId, thresholds } = inputs;
  const alerts: HealthAlert[] = [];

  // --- Capture ------------------------------------------------------------
  if (camera.activeSource === "none") {
    alerts.push({
      level: "error",
      code: "camera-none",
      message: "No camera available - captures will fail. Check USB and digiCamControl.",
    });
  } else if (camera.activeSource !== camera.preference) {
    alerts.push({
      level: "warn",
      code: "camera-fallback",
      message: `Running on ${camera.activeSource} instead of ${camera.preference} - photo quality is reduced.`,
    });
  }

  // --- Print --------------------------------------------------------------
  // Ordering matters: an unwritable hot folder and a dead printer produce the
  // same guest-facing symptom, so report the one the operator can act on.
  if (!hotFolder.writable) {
    alerts.push({
      level: "error",
      code: "hot-folder-unwritable",
      message: `Cannot write to the hot folder (${hotFolder.path}) - nothing will print.`,
    });
  }

  if (!printer.reachable) {
    alerts.push({
      level: "error",
      code: "printer-unreachable",
      message: `Printer status unknown - ${
        printer.error ?? "HotFolderPrint.exe may not be running"
      }. Prints may be piling up unprinted.`,
    });
  } else if (!printer.ok) {
    alerts.push({
      level: "error",
      code: "printer-not-ok",
      message: `Printer reports "${printer.status}" - check media, ribbon and the printer's own display.`,
    });
  } else {
    // Wrong media loaded is another silent failure: the file copy succeeds,
    // HFP accepts it, and nothing usable comes out. HFP reports the loaded
    // media size, so this is cheap to catch before a guest is waiting.
    if (
      printer.mediaType !== null &&
      printer.mediaType.toLowerCase() !== thresholds.expectedMediaType.toLowerCase()
    ) {
      alerts.push({
        level: "error",
        code: "media-type-mismatch",
        message: `Printer has ${printer.mediaType} media loaded but templates are built for ${thresholds.expectedMediaType} - prints will come out wrong.`,
      });
    }

    if (
      printer.mediaRemaining !== null &&
      printer.mediaRemaining <= thresholds.lowMediaWarnPrints
    ) {
      alerts.push({
        level: "warn",
        code: "media-low",
        message: `About ${printer.mediaRemaining} prints left on this roll - have the spare ready.`,
      });
    }
  }

  // --- Storage ------------------------------------------------------------
  if (disk === null) {
    alerts.push({
      level: "warn",
      code: "disk-unknown",
      message: "Could not read free disk space on the data volume.",
    });
  } else if (disk.freeBytes <= thresholds.lowDiskWarnBytes) {
    alerts.push({
      level: "warn",
      code: "disk-low",
      message: `Only ${formatGb(disk.freeBytes)} free on the data volume - captures stop when it fills.`,
    });
  }

  // --- Sync ---------------------------------------------------------------
  // Deliberately never an error: the outbox is designed to survive being
  // offline all night and drain later, so a backlog does not affect guests.
  // Flagging it as an error would train the operator to ignore red.
  if (outbox.queueDepth >= thresholds.outboxBacklogWarn) {
    alerts.push({
      level: "warn",
      code: "outbox-backlog",
      message: `${outbox.queueDepth} captures waiting to upload - they are safe on disk, but check the network when convenient.`,
    });
  }

  return {
    overall: highestLevel(alerts),
    alerts,
    eventId,
    camera: {
      activeSource: camera.activeSource,
      model: camera.activeModel,
      canonConnected: camera.canonConnected,
      webcamConnected: camera.webcamConnected,
      preference: camera.preference,
    },
    hotFolder,
    printer,
    disk,
    outbox,
    timestamp: new Date().toISOString(),
  };
}

function highestLevel(alerts: HealthAlert[]): HealthLevel {
  if (alerts.some((alert) => alert.level === "error")) return "error";
  if (alerts.length > 0) return "warn";
  return "ok";
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
