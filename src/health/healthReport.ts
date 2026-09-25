import { CameraManagerStatus } from "../camera/CameraManager";
import { PrinterStatus } from "../print/printerStatus";
import { DiskSpace } from "../util/disk";
import { SyncSummary } from "../outbox/types";
import { StalledPrints } from "../print/hotFolderStall";
import { CameraDetail } from "../camera/edsdk/protocol";

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
  /** How the Canon is driven, and for EDSDK whether digiCamControl is running too. */
  canon: { driver: "digicamcontrol" | "edsdk"; digiCamControlRunning: boolean };
  hotFolder: { path: string; writable: boolean };
  /** Dropped files HFP has not claimed. See reconcileHotFolderDrops(). */
  stalledPrints: StalledPrints;
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
    driver: "digicamcontrol" | "edsdk";
    battery: CameraDetail["battery"];
    mode: string | null;
    afMode: string | null;
    quality: CameraDetail["quality"];
    lastError: CameraDetail["lastError"];
  };
  hotFolder: { path: string; writable: boolean };
  stalledPrints: StalledPrints;
  printer: PrinterStatus;
  disk: DiskSpace | null;
  outbox: SyncSummary;
  timestamp: string;
}

export function buildHealthReport(inputs: HealthInputs): HealthReport {
  const { camera, canon, hotFolder, stalledPrints, printer, disk, outbox, eventId, thresholds } = inputs;
  const alerts: HealthAlert[] = [];

  // --- Capture ------------------------------------------------------------
  if (camera.activeSource === "none") {
    alerts.push({
      level: "error",
      code: "camera-none",
      message:
        canon.driver === "edsdk"
          ? "No camera available - captures will fail. Check the camera is on and its USB cable is plugged in."
          : "No camera available - captures will fail. Check USB and digiCamControl.",
    });
  } else if (camera.activeSource !== camera.preference) {
    alerts.push({
      level: "warn",
      code: "camera-fallback",
      message: `Running on ${camera.activeSource} instead of ${camera.preference} - photo quality is reduced.`,
    });
  }

  const detail = camera.canonDetail;
  if (canon.driver === "edsdk" && canon.digiCamControlRunning) {
    alerts.push({
      level: "error",
      code: "camera-digicamcontrol-conflict",
      message: "digiCamControl is running and holding the camera - close it (and remove it from startup) so the booth can use the camera.",
    });
  }
  if (detail?.quality && !detail.quality.hasJpeg) {
    alerts.push({
      level: "error",
      code: "camera-raw-only",
      message: `The camera is set to ${detail.quality.label} with no JPEG - captures will fail. Set image quality to include JPEG.`,
    });
  }
  if (typeof detail?.battery === "number" && detail.battery < 20) {
    alerts.push({
      level: "warn",
      code: "camera-battery-low",
      message: `Camera battery at ${detail.battery}% - swap or charge it at the next gap.`,
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

  // Deliberately its own alert rather than folded into printer-unreachable.
  // The two have different causes and different fixes, and this one is the
  // only signal that exists at all when HFP looks healthy but has stopped
  // watching the folder the agent drops into - every other check stays green
  // while nothing physically prints.
  if (stalledPrints.count > 0) {
    const minutes = Math.max(1, Math.round((stalledPrints.oldestAgeSeconds ?? 0) / 60));
    alerts.push({
      level: "error",
      code: "hot-folder-stalled",
      message:
        `${stalledPrints.count} print file(s) are still sitting in the hot folder, the oldest for ` +
        `${minutes} minute(s) - HotFolderPrint has not claimed them and nothing is coming out. ` +
        `Check the HFP window is open and watching ${hotFolder.path}, including whether it has ` +
        `switched to a per-printer subfolder.`,
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

  // Distinct from a backlog on purpose. A backlog clears itself when the
  // network comes back; these never will, and folding them into queueDepth
  // would leave the backlog warning permanently on - training the operator
  // to ignore the one warning that means "the network is still down".
  if (outbox.abandonedCount > 0) {
    alerts.push({
      level: "warn",
      code: "outbox-abandoned",
      message: `${outbox.abandonedCount} capture(s) can never be uploaded - their local files are missing. See GET /sync/abandoned.`,
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
      driver: canon.driver,
      battery: detail?.battery ?? null,
      mode: detail?.mode ?? null,
      afMode: detail?.afMode ?? null,
      quality: detail?.quality ?? null,
      lastError: detail?.lastError ?? null,
    },
    hotFolder,
    stalledPrints,
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
