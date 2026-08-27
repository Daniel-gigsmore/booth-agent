import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../util/logger";

const log = createLogger("print:status");

/**
 * Reads DNP Hot Folder Print's own status file so the agent can tell the
 * difference between "the hot folder is writable" and "the printer will
 * actually produce a print".
 *
 * This gap is the single most dangerous silent failure in the print path:
 * when the DS-RX1HS runs out of media, or HotFolderPrint.exe is closed, the
 * hot folder stays perfectly writable. Files keep landing in `s4x6\` and the
 * agent keeps reporting healthy while nothing physically prints. At a 300-guest
 * event that can burn half an hour before anyone notices.
 *
 * HFP writes `Logs\printer_status.txt` next to its Prints folder. Per the
 * setup notes in README.md this contains at least a `Status` field
 * (`STATUS_OK` when healthy) and the printer model.
 *
 * ---------------------------------------------------------------------------
 * VERIFY BEFORE THE EVENT
 * ---------------------------------------------------------------------------
 * The exact key names below are *not* a documented public API - they are this
 * HFP build's internal shape, exactly like the `s4x6`/`s6x2_2` folder names.
 * Open the real file on the booth PC once and check the keys against
 * STATUS_KEYS / MODEL_KEYS / MEDIA_KEYS. The parser is deliberately tolerant
 * (case-insensitive, several candidate names, tolerates the file being a bare
 * object or an array of printers), and `raw` carries the parsed JSON through
 * so an unrecognised shape can be diagnosed from `GET /health` without RDPing
 * into the booth PC. Fix mismatches in this one file.
 */

/** Candidate JSON keys, matched case-insensitively, first hit wins. */
const STATUS_KEYS = ["status", "printerstatus", "state"];
const MODEL_KEYS = ["model", "printer", "printername", "devicename", "name"];
const MEDIA_KEYS = [
  "mediaremaining",
  "remaining",
  "printsremaining",
  "remainingprints",
  "mediacount",
  "life",
  "paperremaining",
];
/** Confirmed live against the real status file: `"MediaType": "4x6"`. */
const MEDIA_TYPE_KEYS = ["mediatype", "media", "papersize", "size"];
const SERIAL_KEYS = ["serialnumber", "serial"];

/** Status strings HFP reports for a printer that is ready to print. */
const HEALTHY_STATUS_VALUES = ["status_ok", "ok", "ready", "idle"];

export interface PrinterStatus {
  /** The status file exists, parsed, and was written recently enough to trust. */
  reachable: boolean;
  /** reachable AND the reported status is a known-healthy value. */
  ok: boolean;
  /** Raw status string as reported by HFP, e.g. "STATUS_OK". */
  status: string | null;
  model: string | null;
  /** Prints left on the current media roll, when HFP reports it. */
  mediaRemaining: number | null;
  /** Media size physically loaded, e.g. "4x6", when HFP reports it. */
  mediaType: string | null;
  /** Printer serial, so two identical RX1 bodies stay distinguishable. */
  serialNumber: string | null;
  /** mtime of the status file - i.e. when HFP last wrote anything. */
  lastUpdatedAt: string | null;
  /** How long ago that was. Large values mean HFP itself is not running. */
  staleMs: number | null;
  /** Why the status could not be read/trusted, when reachable is false. */
  error: string | null;
  statusFilePath: string;
  /** Parsed JSON passthrough, for diagnosing an unexpected file shape. */
  raw: unknown;
}

/**
 * HFP installs to a fixed location and keeps Logs\ as a sibling of Prints\,
 * so the status file can be derived from the configured hot folder path
 * rather than being another thing to set (and get wrong) in booth.config.json.
 * `printing.printerStatusPath` overrides this if a future HFP version moves it.
 */
export function defaultPrinterStatusPath(hotFolderPath: string): string {
  return path.join(path.dirname(hotFolderPath), "Logs", "printer_status.txt");
}

export interface ReadPrinterStatusOptions {
  statusFilePath: string;
  /**
   * Beyond this age the file is treated as untrustworthy rather than as good
   * news. Critical: a killed HotFolderPrint.exe leaves the last STATUS_OK on
   * disk forever, so mtime is the only thing separating "printer is fine" from
   * "the thing that reports on the printer died an hour ago".
   */
  staleAfterMs: number;
}

export async function readPrinterStatus(
  options: ReadPrinterStatusOptions
): Promise<PrinterStatus> {
  const { statusFilePath, staleAfterMs } = options;
  const base: PrinterStatus = {
    reachable: false,
    ok: false,
    status: null,
    model: null,
    mediaRemaining: null,
    mediaType: null,
    serialNumber: null,
    lastUpdatedAt: null,
    staleMs: null,
    error: null,
    statusFilePath,
    raw: null,
  };

  let stats;
  try {
    stats = await stat(statusFilePath);
  } catch {
    return {
      ...base,
      error:
        "printer status file not found - is HotFolderPrint.exe running, and is printing.hotFolderPath correct?",
    };
  }

  const staleMs = Math.max(0, Date.now() - stats.mtimeMs);
  const lastUpdatedAt = new Date(stats.mtimeMs).toISOString();

  let parsed: unknown;
  try {
    const text = await readFile(statusFilePath, "utf8");
    parsed = JSON.parse(stripBom(text));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Could not parse printer status file at ${statusFilePath}`, err);
    return {
      ...base,
      lastUpdatedAt,
      staleMs,
      error: `printer status file is unreadable or not JSON: ${message}`,
    };
  }

  const record = firstRecord(parsed);
  const status = asString(pick(record, STATUS_KEYS));
  const model = asString(pick(record, MODEL_KEYS));
  const mediaRemaining = asNumber(pick(record, MEDIA_KEYS));
  const mediaType = asString(pick(record, MEDIA_TYPE_KEYS));
  const serialNumber = asString(pick(record, SERIAL_KEYS));

  if (staleMs > staleAfterMs) {
    return {
      ...base,
      status,
      model,
      mediaRemaining,
      mediaType,
      serialNumber,
      lastUpdatedAt,
      staleMs,
      raw: parsed,
      error: `printer status is ${Math.round(
        staleMs / 1000
      )}s old (stale after ${Math.round(
        staleAfterMs / 1000
      )}s) - HotFolderPrint.exe has probably stopped`,
    };
  }

  if (status === null) {
    return {
      ...base,
      model,
      mediaRemaining,
      mediaType,
      serialNumber,
      lastUpdatedAt,
      staleMs,
      raw: parsed,
      error:
        "printer status file has no recognised status field - check STATUS_KEYS in src/print/printerStatus.ts against the real file",
    };
  }

  return {
    reachable: true,
    ok: HEALTHY_STATUS_VALUES.includes(status.trim().toLowerCase()),
    status,
    model,
    mediaRemaining,
    mediaType,
    serialNumber,
    lastUpdatedAt,
    staleMs,
    error: null,
    statusFilePath,
    raw: parsed,
  };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * HFP may report a single printer object or an array of them (the utility
 * supports more than one physical printer). One booth, one printer - take the
 * first entry rather than failing on the array shape.
 */
function firstRecord(parsed: unknown): Record<string, unknown> {
  if (Array.isArray(parsed)) {
    const first = parsed.find((entry) => isRecord(entry));
    return isRecord(first) ? first : {};
  }
  return isRecord(parsed) ? parsed : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Case-insensitive lookup across several candidate key names. */
function pick(record: Record<string, unknown>, candidates: string[]): unknown {
  const lowered = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    lowered.set(key.toLowerCase().replace(/[\s_-]/g, ""), value);
  }
  for (const candidate of candidates) {
    const hit = lowered.get(candidate.replace(/[\s_-]/g, ""));
    if (hit !== undefined && hit !== null) return hit;
  }
  return undefined;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
