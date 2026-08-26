import { access, stat, constants } from "node:fs/promises";
import path from "node:path";
import { BoothConfig } from "../config/schema";
import { hotFolderPathFor, isHotFolderWritable } from "../print/hotFolder";
import {
  readPrinterStatus,
  defaultPrinterStatusPath,
} from "../print/printerStatus";
import { APP_LOG_PATH, isDigiCamControlRunning } from "../camera/CanonTetheredSource";
import { getDiskSpace } from "../util/disk";
import { createLogger } from "../util/logger";

const log = createLogger("preflight");

/**
 * Everything this agent depends on that lives *outside* the repo, checked once
 * at startup instead of at first use.
 *
 * The motivation is specific. Two of the agent's external dependencies are
 * pinned to undocumented internals - digiCamControl's app-log line format and
 * Hot Folder Print's `s4x6`/`s6x2_2` folder names - and both have already
 * drifted once each during development. The old behaviour was to start
 * cleanly and fail on the first `/capture` or the first `/print`, which in
 * practice means failing with a guest standing in front of the booth and a
 * queue behind them.
 *
 * Preflight moves those failures to boot, where the operator has a laptop, no
 * audience, and time to fix them. It is intentionally read-only: it never
 * repairs anything, because a check that quietly fixes its own failure is a
 * check that stops telling you the truth.
 */
export type PreflightLevel = "ok" | "warn" | "fail";

export interface PreflightCheck {
  name: string;
  level: PreflightLevel;
  message: string;
}

export interface PreflightResult {
  level: PreflightLevel;
  checks: PreflightCheck[];
  ranAt: string;
}

function ok(name: string, message: string): PreflightCheck {
  return { name, level: "ok", message };
}
function warn(name: string, message: string): PreflightCheck {
  return { name, level: "warn", message };
}
function fail(name: string, message: string): PreflightCheck {
  return { name, level: "fail", message };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runPreflight(config: BoothConfig): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  checks.push(checkEventId(config));
  checks.push(checkSharedSecret(config));
  checks.push(...(await checkCanon(config)));
  checks.push(await checkWebcam(config));

  // Printer first: whether it is reachable decides how to read a missing
  // hot-folder subfolder (real rename vs HFP simply not up yet).
  const printer = await checkPrinter(config);
  checks.push(printer.check);
  checks.push(...(await checkHotFolders(config, printer.reachable)));
  checks.push(...(await checkStorage(config)));
  checks.push(await checkTemplates(config));

  const level: PreflightLevel = checks.some((c) => c.level === "fail")
    ? "fail"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "ok";

  return { level, checks, ranAt: new Date().toISOString() };
}

/**
 * A wrong event id is the quietest possible failure: everything works, every
 * capture uploads, and they all land under the previous event. There is no
 * symptom until someone goes looking for the photos. Worth a loud banner line
 * on every single boot.
 */
function checkEventId(config: BoothConfig): PreflightCheck {
  const id = config.event.id.trim();
  if (id === "" || id === "your-event-id") {
    return fail("event.id", "event.id is unset or still the example value");
  }
  return ok("event.id", `captures will be tagged "${id}"`);
}

function checkSharedSecret(config: BoothConfig): PreflightCheck {
  if (config.agent.sharedSecret === "change-me-to-a-long-random-string") {
    return fail("agent.sharedSecret", "sharedSecret is still the example value");
  }
  return ok("agent.sharedSecret", "set");
}

async function checkCanon(config: BoothConfig): Promise<PreflightCheck[]> {
  const results: PreflightCheck[] = [];
  const preferred = config.capture.sourcePreference === "canon";
  const level = preferred ? fail : warn;

  const exePath = config.capture.canon.digiCamControlExePath;
  if (await exists(exePath)) {
    results.push(ok("canon.exe", `CameraControlRemoteCmd.exe found`));
  } else {
    results.push(
      level("canon.exe", `CameraControlRemoteCmd.exe not found at ${exePath}`)
    );
  }

  // isHealthy() only needs the app log's mtime as a fallback because it
  // separately trusts a *persisted* connected flag, re-derived from *new* log
  // lines since the last poll - a camera that's stayed connected without
  // interruption can leave the log arbitrarily stale without that meaning
  // anything is wrong, since digiCamControl only appends a line on state
  // *transitions*. A one-shot preflight check has no such history, so log
  // mtime alone is not a safe signal here either - confirmed live: a camera
  // connected for 25+ minutes with zero new log lines, GUI process fully
  // alive throughout. Check the process directly instead, same as isHealthy()
  // does as its own first gate.
  const guiRunning = await isDigiCamControlRunning();
  if (!guiRunning) {
    results.push(
      level("canon.appLog", "CameraControl.exe is not running - launch it before the event")
    );
  } else {
    const logStats = await stat(APP_LOG_PATH).catch(() => null);
    results.push(
      logStats
        ? ok("canon.appLog", "CameraControl.exe running, digiCamControl log present")
        : warn(
            "canon.appLog",
            `CameraControl.exe is running but its log was never created at ${APP_LOG_PATH} - has a camera ever been connected on this install?`
          )
    );
  }

  return results;
}

async function checkWebcam(config: BoothConfig): Promise<PreflightCheck> {
  const ffmpegPath = config.capture.webcam.ffmpegPath;
  // A bare "ffmpeg" is resolved from PATH by the spawn call, so there is
  // nothing to stat - only an absolute path can be checked here.
  if (!path.isAbsolute(ffmpegPath)) {
    return ok("webcam.ffmpeg", `resolved from PATH ("${ffmpegPath}")`);
  }
  return (await exists(ffmpegPath))
    ? ok("webcam.ffmpeg", "found")
    : warn("webcam.ffmpeg", `ffmpeg not found at ${ffmpegPath} - webcam capture will fail`);
}

/**
 * The `s4x6` / `s6x2_2` names are Hot Folder Print's own internal scheme, not
 * a documented API. If a HFP update renames them, the agent's copyFile will
 * happily create a folder with the old name that nothing is watching - files
 * land, `/print` returns 202, and nothing ever prints. Checking that the
 * folders already exist (created by HFP, not by us) catches that rename.
 *
 * ---------------------------------------------------------------------------
 * Why this check is conditional on the printer
 * ---------------------------------------------------------------------------
 * HFP creates these subfolders when it starts and detects the printer - it
 * does not ship them. That produces a guaranteed startup race: this agent is a
 * Windows service running as LocalSystem from boot, while HotFolderPrint.exe
 * lives in the interactive user session and cannot start until someone logs
 * in. HFP is therefore *always* later than preflight.
 *
 * Observed on the booth PC: preflight ran at 13:30 local and reported both
 * folders missing; HFP created them at 14:06 once it came up. Nothing was
 * wrong - the check simply ran too early.
 *
 * Reporting that as a hard failure on every single boot is worse than not
 * checking at all: it is a warning the operator can never act on, and the
 * second time they see it they stop reading preflight altogether. So when the
 * printer is not reachable the folders are reported as unverifiable (warn),
 * and only a *reachable* printer with missing folders is treated as the real
 * rename signal this check exists to catch. Re-run via POST /health/preflight
 * once everything is up to get the meaningful answer.
 */
async function checkHotFolders(
  config: BoothConfig,
  printerReachable: boolean
): Promise<PreflightCheck[]> {
  const results: PreflightCheck[] = [];
  const root = config.printing.hotFolderPath;

  if (!(await exists(root))) {
    results.push(fail("print.hotFolder", `hot folder root does not exist: ${root}`));
    return results;
  }

  // Windows cannot be trusted to answer "is this writable" from permission
  // bits alone, so probe it the same way the print path does.
  results.push(
    (await isHotFolderWritable(root))
      ? ok("print.hotFolder", root)
      : fail("print.hotFolder", `hot folder root is not writable: ${root}`)
  );

  for (const size of ["4x6", "2x6-strip"] as const) {
    const dir = hotFolderPathFor(root, size);
    const name = path.basename(dir);

    if (await exists(dir)) {
      results.push(ok(`print.hotFolder.${size}`, name));
      continue;
    }

    results.push(
      printerReachable
        ? fail(
            `print.hotFolder.${size}`,
            `${name} does not exist under ${root} even though the printer is online - Hot Folder Print may have renamed its profile folders; check HFP and update HFP_FOLDER_BY_SIZE in src/print/hotFolder.ts`
          )
        : warn(
            `print.hotFolder.${size}`,
            `${name} not present yet - HotFolderPrint.exe creates it once it starts and sees the printer. Re-run POST /health/preflight after HFP is up.`
          )
    );
  }

  return results;
}

async function checkPrinter(
  config: BoothConfig
): Promise<{ check: PreflightCheck; reachable: boolean }> {
  const status = await readPrinterStatus({
    statusFilePath:
      config.printing.printerStatusPath ??
      defaultPrinterStatusPath(config.printing.hotFolderPath),
    staleAfterMs: config.printing.printerStatusStaleMs,
  });

  if (!status.reachable) {
    // Same startup race as the hot folders: HFP writes this file, and HFP is
    // not up yet at boot. Not actionable until the operator can act on it.
    return {
      check: warn("print.printer", status.error ?? "printer status unavailable"),
      reachable: false,
    };
  }
  if (!status.ok) {
    return {
      check: fail("print.printer", `printer reports "${status.status}"`),
      reachable: true,
    };
  }
  const media =
    status.mediaRemaining !== null ? `, ~${status.mediaRemaining} prints left` : "";
  const type = status.mediaType ? ` ${status.mediaType}` : "";
  return {
    check: ok(
      "print.printer",
      `${status.model ?? "printer"} ${status.status}${type}${media}`
    ),
    reachable: true,
  };
}

async function checkStorage(config: BoothConfig): Promise<PreflightCheck[]> {
  const results: PreflightCheck[] = [];
  const dataDir = config.storage.dataDir;

  // fs.access(W_OK) on a Windows directory can report success even when the
  // directory is not actually writable (ACLs, and the read-only attribute
  // meaning nothing for directories). The only reliable check is to try.
  results.push(
    (await isHotFolderWritable(dataDir))
      ? ok("storage.dataDir", dataDir)
      : fail("storage.dataDir", `not writable: ${dataDir}`)
  );

  const disk = await getDiskSpace(dataDir);
  if (!disk) {
    results.push(warn("storage.disk", "could not determine free space"));
  } else {
    const freeGb = (disk.freeBytes / 1024 ** 3).toFixed(1);
    results.push(
      disk.freeBytes <= config.storage.lowDiskWarnBytes
        ? warn("storage.disk", `only ${freeGb} GB free on the data volume`)
        : ok("storage.disk", `${freeGb} GB free`)
    );
  }

  return results;
}

async function checkTemplates(config: BoothConfig): Promise<PreflightCheck> {
  const dir = config.compositing.templateDir;
  if (!(await exists(dir))) {
    return fail("compositing.templateDir", `template directory does not exist: ${dir}`);
  }
  return ok("compositing.templateDir", dir);
}

/**
 * Prints the result as a banner. Deliberately noisy: this runs once per boot
 * and is the last chance for a problem to be noticed by someone who is not
 * yet under time pressure.
 */
export function logPreflight(result: PreflightResult): void {
  const symbol: Record<PreflightLevel, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
  log.info("---------- preflight ----------");
  for (const check of result.checks) {
    const line = `[${symbol[check.level]}] ${check.name}: ${check.message}`;
    if (check.level === "fail") log.error(line);
    else if (check.level === "warn") log.warn(line);
    else log.info(line);
  }
  const failed = result.checks.filter((c) => c.level === "fail").length;
  if (result.level === "fail") {
    log.error(
      `---------- preflight FAILED (${failed} blocking) - the booth is NOT ready ----------`
    );
  } else if (result.level === "warn") {
    log.warn("---------- preflight passed with warnings ----------");
  } else {
    log.info("---------- preflight OK ----------");
  }
}
