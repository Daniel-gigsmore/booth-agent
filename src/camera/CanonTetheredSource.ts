import { mkdir, open } from "node:fs/promises";
import { stat } from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { CameraSource, CaptureResult } from "./CameraSource";
import { BoothConfig } from "../config/schema";
import { execFile } from "../util/exec";
import { createLogger } from "../util/logger";

const log = createLogger("camera:canon");

const HEALTH_CHECK_TIMEOUT_MS = 2000;
const REMOTE_CMD_TIMEOUT_MS = 3000;
const CAPTURE_POLL_INTERVAL_MS = 250;
const CAPTURE_POLL_TIMEOUT_MS = 10000;
const LIVEVIEW_FETCH_TIMEOUT_MS = 1500;

/** The main digiCamControl session process. Its mere existence is a prerequisite for a healthy Canon path. */
const GUI_PROCESS_NAME = "CameraControl.exe";

/**
 * digiCamControl's own event log - observed at this path across every
 * install on this machine. Its "Camera is connected" / "Camera
 * disconnected" lines are the ONLY reliable live connection signal found
 * (see isHealthy() below for why the window title isn't one).
 */
const APP_LOG_PATH = "C:\\ProgramData\\digiCamControl\\Log\\app.log";

/**
 * Drives a tethered Canon EOS R100 via digiCamControl rather than a direct
 * EDSDK binding.
 *
 * Why digiCamControl instead of EDSDK: EDSDK is a native C SDK that requires
 * a compiled N-API/FFI addon, a signed Canon developer agreement, and manual
 * per-Windows-build binary management - none of which is practical to
 * maintain for a single in-house booth. digiCamControl is a free, actively
 * maintained Windows application with broad EOS support (R100 confirmed
 * working) and two stable remote-control surfaces we can shell/HTTP into:
 *
 *   1. CameraControlRemoteCmd.exe - a small CLI that talks to an already
 *      running CameraControl.exe (the digiCamControl GUI) session over local
 *      IPC. Verified live against digiCamControl 2.1.7.0 with a real R100:
 *
 *        CameraControlRemoteCmd.exe /c "set session.folder <dir>"
 *        CameraControlRemoteCmd.exe /c "set session.filenametemplate <name>"
 *        CameraControlRemoteCmd.exe /c Capture
 *
 *      Each call returns immediately ("response:null") - the actual shutter
 *      + USB transfer happens asynchronously inside the GUI process and
 *      lands at <dir>\<name>.jpg a few seconds later, so capture() polls for
 *      that file rather than treating the command's own completion as done.
 *      There is no "list connected cameras" command in this CLI's vocabulary
 *      (confirmed via `/c "list cmds"`).
 *   2. The WebServer plugin (enable in digiCamControl > Settings > WebServer,
 *      default port 5513) - serves the current live-view frame as a plain
 *      JPEG at /liveview.jpg, which we poll for the MJPEG preview.
 *
 * Connection health does NOT come from the CLI or the GUI's window title.
 * The window title looked like a clean signal ("digiCamControl - <model>
 * (<serial>)" once connected) and an earlier version of this file used it -
 * until live testing caught it going stale: the title sat on the
 * no-camera-suffix state while the camera was genuinely connected and
 * successfully taking pictures through the GUI. digiCamControl's own event
 * log doesn't have that problem - it logs an unambiguous "===========Camera
 * is connected==============" / "...disconnected==============" line on
 * every real state change - so isHealthy() tails that instead (see
 * APP_LOG_PATH). A log line alone isn't enough on its own, though: if the
 * GUI process is killed outright there's no further log activity at all, so
 * isHealthy() also checks the process is still running as a first gate.
 *
 * IMPORTANT: command names, the app log's path, and its line format have
 * already drifted/surprised once each. Re-verify against your installed
 * build (`CameraControlRemoteCmd.exe /c "list cmds"`, and tail
 * `C:\ProgramData\digiCamControl\Log\app.log` while connecting/
 * disconnecting the camera) if anything changes - this file is the only
 * place that knowledge lives.
 */
export class CanonTetheredSource implements CameraSource {
  readonly kind = "canon" as const;

  private readonly exePath: string;
  private readonly sessionDir: string;
  private readonly liveviewUrl: string;
  private initialized = false;
  private lastKnownModel: string | null = null;
  private lastKnownConnected = false;
  /** Byte offset already consumed from APP_LOG_PATH; makes each health check O(new log growth), not O(log size). */
  private logReadOffset = 0;

  constructor(config: BoothConfig["capture"]["canon"]) {
    this.exePath = config.digiCamControlExePath;
    this.sessionDir = config.sessionDir;
    this.liveviewUrl = `http://${config.digiCamControlHttpHost}:${config.digiCamControlHttpPort}/liveview.jpg`;
  }

  async initialize(): Promise<boolean> {
    await mkdir(this.sessionDir, { recursive: true });
    this.initialized = await this.isHealthy();
    return this.initialized;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const processRunning = await this.isGuiProcessRunning();
      if (!processRunning) {
        this.lastKnownConnected = false;
        this.lastKnownModel = null;
        return false;
      }
      await this.tailAppLog();
      return this.lastKnownConnected;
    } catch (err) {
      log.debug("Canon health check failed", err);
      return false;
    }
  }

  private async isGuiProcessRunning(): Promise<boolean> {
    const result = await execFile(
      "tasklist",
      ["/FI", `IMAGENAME eq ${GUI_PROCESS_NAME}`, "/FO", "CSV", "/NH"],
      { timeoutMs: HEALTH_CHECK_TIMEOUT_MS }
    );
    return result.code === 0 && result.stdout.includes(GUI_PROCESS_NAME);
  }

  /** Reads only the log bytes appended since the last check and updates connection state from them. */
  private async tailAppLog(): Promise<void> {
    const stats = await stat(APP_LOG_PATH).catch(() => null);
    if (!stats) return; // log not created yet; keep prior known state
    if (stats.size < this.logReadOffset) this.logReadOffset = 0; // rotated/truncated

    if (stats.size === this.logReadOffset) return; // nothing new

    const handle = await open(APP_LOG_PATH, "r");
    try {
      const length = stats.size - this.logReadOffset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.logReadOffset);
      this.logReadOffset = stats.size;

      for (const line of buffer.toString("utf-8").split(/\r?\n/)) {
        if (line.includes("Camera is connected")) {
          this.lastKnownConnected = true;
        } else if (line.includes("Camera disconnected")) {
          this.lastKnownConnected = false;
          this.lastKnownModel = null;
        } else if (this.lastKnownConnected) {
          // Only trust a "Name :" line while we believe we're connected -
          // digiCamControl also logs one right after a disconnect (the last
          // known device's name), which would otherwise resurrect a stale model.
          const match = / - Name :(.+)$/.exec(line);
          if (match?.[1]) this.lastKnownModel = match[1].trim();
        }
      }
    } finally {
      await handle.close();
    }
  }

  getModel(): string | null {
    return this.lastKnownModel;
  }

  async capture(destDir: string): Promise<CaptureResult> {
    await mkdir(destDir, { recursive: true });
    const baseName = `canon-${uuidv4()}`;
    const filePath = path.join(destDir, `${baseName}.jpg`);

    await this.runRemoteCmd(`set session.folder ${destDir}`);
    await this.runRemoteCmd(`set session.filenametemplate ${baseName}`);
    await this.runRemoteCmd("Capture");

    await this.waitForFile(filePath);

    const metadata = await sharp(filePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`Canon capture produced an unreadable image: ${filePath}`);
    }

    return { filePath, width: metadata.width, height: metadata.height };
  }

  private async runRemoteCmd(command: string): Promise<void> {
    const result = await execFile(this.exePath, ["/c", command], {
      timeoutMs: REMOTE_CMD_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.stdout.includes(":;response:error")) {
      throw new Error(
        `Canon remote command failed ("${command}", exit ${String(result.code)}): ${
          result.stdout || result.stderr
        }`
      );
    }
  }

  /** Capture is asynchronous: the remote command returns before the file exists. */
  private async waitForFile(filePath: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < CAPTURE_POLL_TIMEOUT_MS) {
      try {
        const info = await stat(filePath);
        if (info.size > 0) {
          // Grace period so we don't read a still-being-written file.
          await new Promise((resolve) => setTimeout(resolve, CAPTURE_POLL_INTERVAL_MS));
          const settled = await stat(filePath);
          if (settled.size === info.size) return;
        }
      } catch {
        // File doesn't exist yet; keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_POLL_INTERVAL_MS));
    }
    throw new Error(`Canon capture timed out waiting for ${filePath}`);
  }

  async getLiveviewFrame(): Promise<Buffer | null> {
    if (!this.initialized) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LIVEVIEW_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(this.liveviewUrl, { signal: controller.signal });
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      log.debug("Canon live view frame fetch failed", err);
      return null;
    }
  }
}
