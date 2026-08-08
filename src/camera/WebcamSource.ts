import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { CameraSource, CaptureResult } from "./CameraSource";
import { BoothConfig } from "../config/schema";
import { execFile } from "../util/exec";
import { createLogger } from "../util/logger";

const log = createLogger("camera:webcam");

const HEALTH_CHECK_TIMEOUT_MS = 1000;
const CAPTURE_TIMEOUT_MS = 5000;
const LIVEVIEW_TIMEOUT_MS = 2000;

/**
 * Fallback (and directly selectable) capture source for any UVC-class webcam,
 * driven through ffmpeg's DirectShow (dshow) input on Windows. This is a
 * first-class CameraSource, not a stub - it must be able to run a full
 * session end to end with no Canon attached.
 */
export class WebcamSource implements CameraSource {
  readonly kind = "webcam" as const;

  private readonly ffmpegPath: string;
  private readonly deviceName: string;
  private readonly width: number;
  private readonly height: number;

  constructor(config: BoothConfig["capture"]["webcam"]) {
    this.ffmpegPath = config.ffmpegPath;
    this.deviceName = config.deviceName;
    this.width = config.captureWidth;
    this.height = config.captureHeight;
  }

  async initialize(): Promise<boolean> {
    return this.isHealthy();
  }

  async shutdown(): Promise<void> {
    // No persistent handle is held between calls; nothing to release.
  }

  getModel(): string | null {
    return this.deviceName;
  }

  async isHealthy(): Promise<boolean> {
    try {
      // ffmpeg enumerates dshow devices to stderr and exits non-zero for the
      // bogus "dummy" input; that's expected, we only care about the listing.
      const result = await execFile(
        this.ffmpegPath,
        ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"],
        { timeoutMs: HEALTH_CHECK_TIMEOUT_MS }
      );
      const output = `${result.stdout}\n${result.stderr}`;
      return output.includes(this.deviceName);
    } catch (err) {
      log.debug("Webcam health check failed", err);
      return false;
    }
  }

  async capture(destDir: string): Promise<CaptureResult> {
    await mkdir(destDir, { recursive: true });
    const fileName = `webcam-${uuidv4()}.jpg`;
    const filePath = path.join(destDir, fileName);

    const args = [
      "-hide_banner",
      "-y",
      "-f",
      "dshow",
      "-video_size",
      `${this.width}x${this.height}`,
      "-i",
      `video=${this.deviceName}`,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      filePath,
    ];

    const result = await execFile(this.ffmpegPath, args, { timeoutMs: CAPTURE_TIMEOUT_MS });
    if (result.code !== 0) {
      throw new Error(`Webcam capture failed (exit ${String(result.code)}): ${result.stderr}`);
    }

    const metadata = await sharp(filePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`Webcam capture produced an unreadable image: ${filePath}`);
    }

    return { filePath, width: metadata.width, height: metadata.height };
  }

  async getLiveviewFrame(): Promise<Buffer | null> {
    // Grabs a single frame and streams it out over stdout as MJPEG, avoiding
    // a disk round-trip per preview tick. Spawning ffmpeg per frame caps the
    // achievable preview frame rate (a few fps) - acceptable for a booth
    // preview; a persistent ffmpeg stream demuxer would be the next step if
    // a smoother live view is needed later.
    return new Promise((resolve) => {
      const args = [
        "-hide_banner",
        "-f",
        "dshow",
        "-video_size",
        `${this.width}x${this.height}`,
        "-i",
        `video=${this.deviceName}`,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ];

      const child = spawn(this.ffmpegPath, args, { windowsHide: true });
      const chunks: Buffer[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve(null);
      }, LIVEVIEW_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0 || chunks.length === 0) {
          resolve(null);
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }
}
