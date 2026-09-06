import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { CameraSource, CaptureResult } from "./CameraSource";
import { BoothConfig } from "../config/schema";
import { execFile } from "../util/exec";
import { AsyncMutex } from "../util/mutex";
import { MjpegFrameParser } from "./mjpegFrameParser";
import { createLogger } from "../util/logger";

const log = createLogger("camera:webcam");

const HEALTH_CHECK_TIMEOUT_MS = 1000;
const CAPTURE_TIMEOUT_MS = 5000;
const LIVEVIEW_TARGET_FPS = 10;
// A poller still watching /liveview calls getLiveviewFrame() every ~150ms
// (see routes.ts), so this is over 10x that - trivial for a live viewer to
// keep the stream alive, but short enough that a client which stopped
// polling (closed the page, or CameraManager switched away from webcam)
// lets the device go within a couple of seconds instead of holding it open
// for the rest of the event.
const LIVEVIEW_IDLE_TIMEOUT_MS = 2000;

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
  // capture() and getLiveviewFrame() each need exclusive use of the dshow
  // device - a UVC webcam only tolerates one open handle at a time. Without
  // this lock, a live-view poll racing a shutter press produced a "device
  // busy" failure on whichever call lost. isHealthy() deliberately isn't
  // serialized through this - list_devices only enumerates, it never opens
  // the device, so it can't contend with either.
  private readonly deviceLock = new AsyncMutex();

  private liveviewProc: ChildProcessWithoutNullStreams | null = null;
  private liveviewParser = new MjpegFrameParser();
  private latestFrame: Buffer | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

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
    await this.deviceLock.run(() => this.stopLiveviewProcess());
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
    return this.deviceLock.run(() => this.captureExclusive(destDir));
  }

  private async captureExclusive(destDir: string): Promise<CaptureResult> {
    // The live-view stream and a still capture can't both hold the dshow
    // device open at once - yield it before shelling out for the shutter.
    // getLiveviewFrame() will lazily start a fresh stream again on its next
    // poll, same as it does after any other unexpected stop.
    await this.stopLiveviewProcess();

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
    return this.deviceLock.run(() => this.getLiveviewFrameExclusive());
  }

  private async getLiveviewFrameExclusive(): Promise<Buffer | null> {
    this.ensureLiveviewProcess();
    this.scheduleIdleStop();
    return this.latestFrame;
  }

  /**
   * Starts the long-lived ffmpeg process that streams continuous MJPEG over
   * its stdout, if one isn't already running. Spawning a fresh ffmpeg per
   * preview frame (the previous approach) capped achievable frame rate at a
   * few fps; a single persistent process demuxed with MjpegFrameParser holds
   * the device open once and just hands back whatever the latest decoded
   * frame is on each poll.
   */
  private ensureLiveviewProcess(): void {
    if (this.liveviewProc) return;

    const args = [
      "-hide_banner",
      "-f",
      "dshow",
      "-video_size",
      `${this.width}x${this.height}`,
      "-i",
      `video=${this.deviceName}`,
      "-r",
      String(LIVEVIEW_TARGET_FPS),
      "-f",
      "mjpeg",
      "-q:v",
      "5",
      "pipe:1",
    ];

    this.liveviewParser = new MjpegFrameParser();
    this.latestFrame = null;

    const child = spawn(this.ffmpegPath, args, { windowsHide: true });
    this.liveviewProc = child;

    let stderrTail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const frames = this.liveviewParser.push(chunk);
      if (frames.length > 0) this.latestFrame = frames[frames.length - 1] ?? null;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-4000);
    });
    child.on("error", (err) => {
      if (this.liveviewProc !== child) return;
      this.liveviewProc = null;
      log.debug("Webcam live-view stream failed to start", err);
    });
    child.on("close", (code) => {
      if (this.liveviewProc !== child) return;
      this.liveviewProc = null;
      if (code !== null && code !== 0) {
        log.warn(`Webcam live-view stream exited unexpectedly (code ${String(code)})`, stderrTail);
      }
    });
  }

  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.deviceLock.run(() => this.stopLiveviewProcess());
    }, LIVEVIEW_IDLE_TIMEOUT_MS);
  }

  private stopLiveviewProcess(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const proc = this.liveviewProc;
    this.liveviewProc = null;
    this.latestFrame = null;
    if (!proc) return Promise.resolve();

    return new Promise((resolve) => {
      proc.once("close", () => resolve());
      proc.kill("SIGKILL");
    });
  }
}
