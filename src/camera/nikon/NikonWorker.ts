import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { NikonApi, NikonDevice } from "./nikonApi";
import { DISCONNECT_RESULTS, NK, nkError } from "./nikonLayout";
import { CameraDetail, CameraSettings, LogLevel, WorkerEvent } from "../edsdk/protocol";
import { Clock, realClock } from "../edsdk/CameraWorker";
import { AsyncMutex } from "../../util/mutex";

const SCAN_INTERVAL_MS = 1_000;
// A body another program holds (NX Tether, Camera Control Pro) is only retried this often.
const HELD_RETRY_MS = 15_000;
// The device list is also re-read on DeviceInfoChanged; this catches a missed event.
const PRESENCE_CHECK_MS = 3_000;
const STATUS_POLL_MS = 5_000;
const LIVEVIEW_IDLE_MS = 10_000;
// A frame older than this is a frozen picture, not live view.
const FRAME_FRESH_MS = 1_000;
// The whole capture gives up just before the agent's 12 s request timeout.
const CAPTURE_DEADLINE_MS = 11_000;
const BUSY_RETRY_DELAY_MS = 500;
const FILE_POLL_MS = 100;
// How long a lone RAW file sits in the folder before we stop waiting for its JPEG twin.
const RAW_ONLY_GRACE_MS = 1_500;
// Without the SDK's ImageSaved event, a JPEG whose size hasn't changed for this long counts as written.
const STABLE_FILE_MS = 600;
const REPEAT_QUIET_MS = 60_000;

const JPEG = /\.jpe?g$/i;

/** "Z 30" -> "Nikon Z 30", so /health and the Camera tab say which brand it is. */
export function modelName(deviceName: string): string {
  const name = deviceName.trim() || "camera";
  return /^nikon\b/i.test(name) ? name : `Nikon ${name}`;
}

/**
 * Everything the Nikon worker process does with the camera, written against
 * NikonApi so it can be tested without one. Mirrors the Canon CameraWorker's
 * contract (same protocol, same events), but the SDK is different in kind:
 * every call is async, the SDK writes the photo to a folder itself, and live
 * view frames are pushed to us rather than pulled.
 *
 * All SDK calls go through one mutex: the SDK is driven from koffi's worker
 * threads, and two calls must never be inside it at once.
 */
export class NikonWorker {
  private device: NikonDevice | null = null;
  private readonly sdk = new AsyncMutex();
  private devicesChanged = false;
  private lastScanAt = Number.NEGATIVE_INFINITY;
  private lastPresenceAt = 0;
  private readonly heldUntil = new Map<number, number>();
  private announced = false;
  private capturing = false;
  /** Set by an SDK event while a shot is in progress: the photo will never arrive. */
  private shotFailure: string | null = null;
  /** Lower-cased names of files the SDK reported finished (ImageSaved) during this shot. */
  private readonly savedNames = new Set<string>();
  private liveviewOn = false;
  private liveviewStarting = false;
  private lastFrameRequestAt = 0;
  private latestFrame: { jpeg: Buffer; at: number } | null = null;
  private lastStatusAt = 0;
  private lastStatusSent = "";
  private battery: number | null = null;
  private lastError: CameraDetail["lastError"] = null;
  private readonly lastWarnAt = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly api: NikonApi,
    private readonly emit: (event: WorkerEvent) => void,
    /** Where the SDK may put a photo when a shot's own folder is refused. */
    private readonly defaultSaveDir: string,
    private readonly clock: Clock = realClock
  ) {}

  get connected(): boolean {
    return this.device !== null;
  }

  async start(): Promise<void> {
    await mkdir(this.defaultSaveDir, { recursive: true });
    const err = await this.sdk.run(() =>
      this.api.initialize(
        {
          onEvent: (event) => this.onEvent(event),
          onLiveViewFrame: (jpeg) => {
            this.latestFrame = { jpeg, at: this.clock.now() };
          },
          onImageSaved: (file) => {
            this.savedNames.add(path.win32.basename(file).toLowerCase());
            this.log("debug", `Nikon saved ${file}`);
          },
        },
        this.defaultSaveDir
      )
    );
    if (err !== NK.OK) throw new Error(`Nikon InitializeSDK failed: ${nkError(err)}`);
  }

  /** One pass of housekeeping; worker.ts calls it on a timer and never runs two at once. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.clock.now();
    if (!this.device) {
      if (now - this.lastScanAt >= SCAN_INTERVAL_MS || this.devicesChanged) {
        this.lastScanAt = now;
        this.devicesChanged = false;
        await this.scan();
        // Let the agent stop waiting at startup: no camera is an answer too.
        if (!this.announced && !this.device) this.emit({ type: "state", connected: false, model: null, serial: null });
        this.announced = true;
      }
      return;
    }
    if (this.capturing) return;
    if (this.devicesChanged || now - this.lastPresenceAt >= PRESENCE_CHECK_MS) {
      this.devicesChanged = false;
      this.lastPresenceAt = now;
      if (!(await this.stillPresent())) {
        await this.drop("Nikon camera disconnected");
        return;
      }
    }
    if (this.liveviewOn && now - this.lastFrameRequestAt >= LIVEVIEW_IDLE_MS) {
      await this.setLiveview(false);
    }
    if (now - this.lastStatusAt >= STATUS_POLL_MS) {
      this.lastStatusAt = now;
      await this.pollStatus();
    }
  }

  async capture(destPath: string): Promise<void> {
    if (!this.device) throw new Error("No Nikon camera connected");
    if (this.capturing) throw new Error("A Nikon capture is already in progress");
    this.capturing = true;
    this.shotFailure = null;
    this.savedNames.clear();
    const deadline = this.clock.now() + CAPTURE_DEADLINE_MS;
    // A private folder per shot, next to the destination (same drive, so the
    // final rename is atomic): the SDK picks the file name itself.
    const shotDir = path.join(path.dirname(destPath), `.nikon-${path.basename(destPath, path.extname(destPath))}`);
    try {
      await mkdir(shotDir, { recursive: true });
      await this.shoot(shotDir, deadline);
      const jpeg = await this.waitForJpeg(shotDir, deadline);
      await rename(jpeg, destPath);
    } catch (err) {
      this.recordError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      this.capturing = false;
      await rm(shotDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The latest live-view frame, starting live view if it isn't running. Null until frames arrive. */
  frame(): Uint8Array | null {
    if (!this.device) return null;
    const now = this.clock.now();
    this.lastFrameRequestAt = now;
    if (!this.liveviewOn && !this.liveviewStarting) {
      this.setLiveview(true).catch((err: unknown) => this.warnQuietly(`Nikon live view failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    const latest = this.latestFrame;
    return latest && now - latest.at <= FRAME_FRESH_MS ? latest.jpeg : null;
  }

  getSettings(): CameraSettings {
    throw new Error("Camera settings aren't supported for the Nikon yet - change them on the camera");
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.sdk.run(async () => {
      if (this.liveviewOn) await this.api.stopLiveView().catch(() => undefined);
      if (this.device) await this.api.disconnect().catch(() => undefined);
      await this.api.terminate().catch(() => undefined);
    });
    this.device = null;
  }

  private onEvent(event: number): void {
    switch (event) {
      case NK.EVENT_DEVICE_INFO_CHANGED:
        this.devicesChanged = true;
        break;
      case NK.EVENT_STORAGE_FULL_IMAGE_NOT_SAVED:
        if (this.capturing) this.shotFailure = "The PC drive is full - the Nikon photo was not saved";
        break;
      case NK.EVENT_ACQUIRE_FAILED_IMAGE_NOT_SAVED:
        if (this.capturing) this.shotFailure = "The Nikon photo could not be transferred to the PC";
        break;
    }
  }

  private async scan(): Promise<void> {
    const { err, devices } = await this.sdk.run(() => this.api.devices());
    if (err !== NK.OK) {
      this.warnQuietly(`Could not list Nikon cameras: ${nkError(err)}`);
      return;
    }
    const now = this.clock.now();
    const candidates = devices.filter((d) => d.available && (this.heldUntil.get(d.id) ?? 0) <= now);
    if (candidates.length === 0) {
      if (devices.some((d) => !d.available)) {
        this.warnQuietly("The Nikon is connected but another program has it - close NX Tether, Camera Control Pro 2 and Nikon Transfer 2");
      }
      return;
    }
    for (const device of candidates) {
      const connectErr = await this.sdk.run(() => this.api.connect(device.id));
      if (connectErr !== NK.OK) {
        this.heldUntil.set(device.id, now + HELD_RETRY_MS);
        this.warnQuietly(`Could not open the Nikon (${device.name}): ${nkError(connectErr)}`);
        continue;
      }
      this.heldUntil.clear();
      // Card (the default) would leave every photo on the SD card and never send it to the PC.
      const mediaErr = await this.sdk.run(() => this.api.setUnsigned(NK.CAP_SAVE_MEDIA, NK.SAVE_MEDIA_SDRAM));
      if (mediaErr !== NK.OK) this.log("warn", `Could not set the Nikon to save to the PC: ${nkError(mediaErr)}`);
      this.device = device;
      this.lastPresenceAt = this.clock.now();
      this.lastStatusAt = 0;
      this.log("info", `Connected to ${modelName(device.name)}`);
      this.emit({ type: "state", connected: true, model: modelName(device.name), serial: null });
      return;
    }
  }

  private async stillPresent(): Promise<boolean> {
    const id = this.device?.id;
    const { err, devices } = await this.sdk.run(() => this.api.devices());
    // A failed listing isn't proof the camera has gone; the next check decides.
    if (err !== NK.OK) return true;
    return devices.some((d) => d.id === id);
  }

  private async drop(reason: string): Promise<void> {
    if (!this.device) return;
    this.device = null;
    this.liveviewOn = false;
    this.latestFrame = null;
    this.battery = null;
    this.log("warn", reason);
    this.recordError(reason);
    await this.sdk.run(() => this.api.disconnect()).catch(() => undefined);
    this.emit({ type: "state", connected: false, model: null, serial: null });
  }

  private async shoot(shotDir: string, deadline: number): Promise<void> {
    let autoFocus = true;
    let stoppedLiveview = false;
    for (;;) {
      const err = await this.sdk.run(() => this.api.shoot(shotDir, autoFocus));
      if (err === NK.OK) return;
      // Like the Canon on 8D01: a missed focus becomes a shot without autofocus, not no photo.
      if ((err === NK.OUT_OF_FOCUS || err === NK.WAITING_2ND_RELEASE) && autoFocus) {
        this.log("warn", `Nikon couldn't focus (${nkError(err)}), retaking without autofocus`);
        autoFocus = false;
        continue;
      }
      if (err === NK.INVALID_STATE && this.liveviewOn && !stoppedLiveview) {
        stoppedLiveview = true;
        await this.setLiveview(false);
        continue;
      }
      if (err === NK.DEVICE_BUSY && this.clock.now() + BUSY_RETRY_DELAY_MS < deadline) {
        await this.clock.sleep(BUSY_RETRY_DELAY_MS);
        continue;
      }
      if (DISCONNECT_RESULTS.has(err)) void this.drop(`Nikon disconnected during a shot (${nkError(err)})`);
      throw new Error(`Nikon shot failed: ${nkError(err)}`);
    }
  }

  /**
   * The SDK writes the photo into the shot folder under its own name, possibly
   * after StartShooting has returned, and says so with an ImageSaved event.
   * A JPEG counts as finished on that event, or - should the event not come -
   * once its size has stopped changing for STABLE_FILE_MS.
   */
  private async waitForJpeg(shotDir: string, deadline: number): Promise<string> {
    let candidate = null as { file: string; size: number; since: number } | null;
    let rawOnlySince = null as number | null;
    for (;;) {
      if (this.shotFailure) throw new Error(this.shotFailure);
      const files = await readdir(shotDir).catch(() => [] as string[]);
      const jpeg = files.find((f) => JPEG.test(f));
      if (jpeg) {
        const file = path.join(shotDir, jpeg);
        if (this.savedNames.has(jpeg.toLowerCase())) return file;
        const size = (await stat(file).catch(() => null))?.size ?? 0;
        const now = this.clock.now();
        if (candidate?.file !== file || candidate.size !== size) candidate = { file, size, since: now };
        else if (size > 0 && now - candidate.since >= STABLE_FILE_MS) return file;
      } else if (files.length > 0) {
        rawOnlySince ??= this.clock.now();
        if (this.clock.now() - rawOnlySince >= RAW_ONLY_GRACE_MS) {
          throw new Error("The Nikon saved only a RAW file - set Image quality to JPEG (or RAW + JPEG) on the camera");
        }
      }
      if (this.clock.now() >= deadline) throw new Error("The Nikon photo did not reach the PC in time");
      await this.clock.sleep(FILE_POLL_MS);
    }
  }

  private async setLiveview(on: boolean): Promise<void> {
    if (on) {
      this.liveviewStarting = true;
      try {
        const err = await this.sdk.run(() => this.api.startLiveView());
        if (err === NK.OK || err === NK.LIVEVIEW_ALREADY_STARTED) {
          this.liveviewOn = true;
        } else {
          this.warnQuietly(`Nikon live view would not start: ${nkError(err)}`);
        }
      } finally {
        this.liveviewStarting = false;
      }
      return;
    }
    this.liveviewOn = false;
    this.latestFrame = null;
    const err = await this.sdk.run(() => this.api.stopLiveView());
    if (err !== NK.OK && err !== NK.LIVEVIEW_ALREADY_STOPPED) this.log("debug", `Nikon live view stop: ${nkError(err)}`);
  }

  private async pollStatus(): Promise<void> {
    const { err, value } = await this.sdk.run(() => this.api.getInteger(NK.CAP_BATTERY_LEVEL));
    if (err === NK.OK) this.battery = value;
    this.publishStatus();
  }

  private publishStatus(): void {
    const detail: CameraDetail = { battery: this.battery, mode: null, afMode: null, quality: null, lastError: this.lastError };
    const json = JSON.stringify(detail);
    if (json === this.lastStatusSent) return;
    this.lastStatusSent = json;
    this.emit({ type: "status", detail });
  }

  private recordError(message: string): void {
    this.lastError = { message, at: new Date(this.clock.now()).toISOString() };
    this.publishStatus();
  }

  private warnQuietly(message: string): void {
    const now = this.clock.now();
    const last = this.lastWarnAt.get(message);
    if (last !== undefined && now - last < REPEAT_QUIET_MS) return;
    this.lastWarnAt.set(message, now);
    this.log("warn", message);
  }

  private log(level: LogLevel, message: string): void {
    this.emit({ type: "log", level, message });
  }
}
