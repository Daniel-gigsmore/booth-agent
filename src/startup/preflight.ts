import { access, stat, constants } from "node:fs/promises";
import path from "node:path";
import { BoothConfig } from "../config/schema";
import { hotFolderPathFor } from "../print/hotFolder";
import {
  readPrinterStatus,
  defaultPrinterStatusPath,
} from "../print/printerStatus";
import { APP_LOG_PATH } from "../camera/CanonTetheredSource";
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
  checks.push(...(await checkHotFolders(config)));
  checks.push(await checkPrinter(config));
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

  // The app log is how isHealthy() decides whether the camera is connected.
  // A missing log means digiCamControl has never run on this machine; a very
  // old one means it is not running now - and in that state the agent cannot
  // tell a disconnected camera from a dead digiCamControl.
  const logStats = await stat(APP_LOG_PATH).catch(() => null);
  if (!logStats) {
    results.push(
      level(
        "canon.appLog",
        `digiCamControl log not found at ${APP_LOG_PATH} - launch CameraControl.exe at least once`
      )
    );
  } else {
    const ageMinutes = Math.round((Date.now() - logStats.mtimeMs) / 60000);
    results.push(
      ageMinutes > 10
        ? level(
            "canon.appLog",
            `digiCamControl log last written ${ageMinutes} min ago - CameraControl.exe is probably not running`
          )
        : ok("canon.appLog", `digiCamControl log is live (${ageMinutes} min old)`)
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
 */
async function checkHotFolders(config: BoothConfig): Promise<PreflightCheck[]> {
  const results: PreflightCheck[] = [];
  const root = config.printing.hotFolderPath;

  if (!(await exists(root))) {
    results.push(fail("print.hotFolder", `hot folder root does not exist: ${root}`));
    return results;
  }
  results.push(ok("print.hotFolder", root));

  for (const size of ["4x6", "2x6-strip"] as const) {
    const dir = hotFolderPathFor(root, size);
    results.push(
      (await exists(dir))
        ? ok(`print.hotFolder.${size}`, path.basename(dir))
        : fail(
            `print.hotFolder.${size}`,
            `${path.basename(dir)} does not exist under ${root} - Hot Folder Print may have renamed its profile folders; check HFP and update HFP_FOLDER_BY_SIZE in src/print/hotFolder.ts`
          )
    );
  }

  return results;
}

async function checkPrinter(config: BoothConfig): Promise<PreflightCheck> {
  const status = await readPrinterStatus({
    statusFilePath:
      config.printing.printerStatusPath ??
      defaultPrinterStatusPath(config.printing.hotFolderPath),
    staleAfterMs: config.printing.printerStatusStaleMs,
  });

  if (!status.reachable) {
    return fail("print.printer", status.error ?? "printer status unavailable");
  }
  if (!status.ok) {
    return fail("print.printer", `printer reports "${status.status}"`);
  }
  const media =
    status.mediaRemaining !== null ? `, ~${status.mediaRemaining} prints left` : "";
  return ok("print.printer", `${status.model ?? "printer"} ${status.status}${media}`);
}

async function checkStorage(config: BoothConfig): Promise<PreflightCheck[]> {
  const results: PreflightCheck[] = [];
  const dataDir = config.storage.dataDir;

  try {
    await access(dataDir, constants.W_OK);
    results.push(ok("storage.dataDir", dataDir));
  } catch {
    results.push(fail("storage.dataDir", `not writable: ${dataDir}`));
  }

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
