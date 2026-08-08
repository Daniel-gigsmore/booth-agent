import { mkdir } from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { CameraSource, CaptureResult } from "./CameraSource";
import { BoothConfig } from "../config/schema";
import { execFile } from "../util/exec";
import { createLogger } from "../util/logger";

const log = createLogger("camera:canon");

const HEALTH_CHECK_TIMEOUT_MS = 1000;
const CAPTURE_TIMEOUT_MS = 8000;
const LIVEVIEW_FETCH_TIMEOUT_MS = 1500;

/**
 * Drives a tethered Canon EOS R100 via digiCamControl rather than a direct
 * EDSDK binding.
 *
 * Why digiCamControl instead of EDSDK: EDSDK is a native C SDK that requires
 * a compiled N-API/FFI addon, a signed Canon developer agreement, and manual
 * per-Windows-build binary management - none of which is practical to
 * maintain for a single in-house booth. digiCamControl is a free, actively
 * maintained Windows application with broad EOS support (R100 included) and
 * two stable remote-control surfaces we can shell/HTTP into:
 *
 *   1. CameraControlRemoteCmd.exe - a small CLI that talks to an already
 *      running digiCamControl.exe instance over a local IPC channel. We use
 *      it for session/connection queries and for triggering captures.
 *   2. The WebServer plugin (enable in digiCamControl > Settings > WebServer,
 *      default port 5513) - serves the current live-view frame as a plain
 *      JPEG at /liveview.jpg, which we poll for the MJPEG preview.
 *
 * IMPORTANT: CameraControlRemoteCmd.exe's exact flag names have drifted
 * across digiCamControl releases. Verify them against your installed build
 * with `CameraControlRemoteCmd.exe /help` and adjust the two command arrays
 * below if they differ - this file is the ONLY place that knowledge lives.
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
      const result = await execFile(this.exePath, ["/c", "list"], {
        timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
      });
      if (result.code !== 0) return false;
      // digiCamControl prints one connected camera per line, or nothing when idle.
      const cameraLines = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (cameraLines.length > 0) {
        this.lastKnownModel = cameraLines[0] ?? null;
        return true;
      }
      return false;
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
    const fileName = `canon-${uuidv4()}.jpg`;
    const filePath = path.join(destDir, fileName);

    const result = await execFile(
      this.exePath,
      ["/filename", filePath, "/capture"],
      { timeoutMs: CAPTURE_TIMEOUT_MS }
    );

    if (result.code !== 0) {
      throw new Error(
        `Canon capture failed (exit ${String(result.code)}): ${result.stderr || result.stdout}`
      );
    }

    const metadata = await sharp(filePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`Canon capture produced an unreadable image: ${filePath}`);
    }

    return { filePath, width: metadata.width, height: metadata.height };
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
