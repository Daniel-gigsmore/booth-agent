import { mkdir } from "node:fs/promises";
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

/** The main digiCamControl session process; its window title carries live connection status. */
const GUI_PROCESS_NAME = "CameraControl.exe";

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
 *      (confirmed via `/c "list cmds"`) - connection status instead comes
 *      from the GUI process's window title (see isHealthy()/getModel()).
 *   2. The WebServer plugin (enable in digiCamControl > Settings > WebServer,
 *      default port 5513) - serves the current live-view frame as a plain
 *      JPEG at /liveview.jpg, which we poll for the MJPEG preview.
 *
 * IMPORTANT: command names and the window-title format have already drifted
 * once from what generic digiCamControl documentation suggests. Re-verify
 * against your installed build (`CameraControlRemoteCmd.exe /c "list cmds"`,
 * and `tasklist /FI "IMAGENAME eq CameraControl.exe" /V`) if either changes
 * again - this file is the only place that knowledge lives.
 */
export class CanonTetheredSource implements CameraSource {
  readonly kind = "canon" as const;

  private readonly exePath: string;
  private readonly sessionDir: string;
  private readonly liveviewUrl: string;
  private initialized = false;
  private lastKnownModel: string | null = null;

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
      const result = await execFile(
        "tasklist",
        ["/FI", `IMAGENAME eq ${GUI_PROCESS_NAME}`, "/V", "/FO", "CSV", "/NH"],
        { timeoutMs: HEALTH_CHECK_TIMEOUT_MS }
      );
      if (result.code !== 0) return false;

      // CSV, last column is Window Title; digiCamControl sets it to
      // "digiCamControl - <model> (<serial>)" once a camera is connected,
      // and to just "digiCamControl" (or similar, no " - ") when idle.
      const line = result.stdout.trim().split(/\r?\n/).pop();
      if (!line || !line.includes(GUI_PROCESS_NAME)) return false;

      const fields = line.split('","').map((f) => f.replace(/^"|"$/g, ""));
      const windowTitle = fields[fields.length - 1] ?? "";
      const match = /digiCamControl - (.+?) \(/.exec(windowTitle);
      if (!match?.[1]) return false;

      this.lastKnownModel = match[1];
      return true;
    } catch (err) {
      log.debug("Canon health check failed", err);
      return false;
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
