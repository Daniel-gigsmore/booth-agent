import { DISCONNECT_ERRORS, EDS, EdsApi, EdsRef, hex } from "./edsdkApi";
import { LogLevel, WorkerEvent } from "./protocol";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const SCAN_INTERVAL_MS = 1_000;
// EdsGetCameraList in a long-lived process may not notice a re-plugged
// camera; re-initializing the SDK now and then forces a fresh device list.
const REINIT_AFTER_EMPTY_SCANS = 5;
const KEEP_AWAKE_MS = 60_000;
const BUSY_RETRY_DELAY_MS = 500;
const TRANSFER_TIMEOUT_MS = 10_000;
const EVENT_POLL_MS = 30;
const LIVEVIEW_IDLE_MS = 10_000;

/**
 * Everything the camera worker process does with the Canon, written against
 * EdsApi so it can be tested without a camera. Runs on the worker's single
 * thread: tick() is called every ~30 ms by worker.ts, and every EDSDK call
 * (including the event handlers, which fire inside getEvent()) happens there.
 */
export class CameraWorker {
  private cam: EdsRef | null = null;
  private lastScanAt = Number.NEGATIVE_INFINITY;
  private emptyScans = 0;
  private lastKeepAwakeAt = 0;
  /** Set by the state handler; acted on after getEvent() returns, never re-entrantly inside it. */
  private shutdownSeen = false;
  /** The capture waiting for its photo; the object handler downloads into it. */
  private pendingTransfer: { destPath: string; done: boolean; err: number } | null = null;
  private capturing = false;
  private liveviewOn = false;
  private lastFrameAt = 0;

  constructor(
    private readonly eds: EdsApi,
    private readonly emit: (event: WorkerEvent) => void,
    private readonly clock: Clock = realClock
  ) {}

  get connected(): boolean {
    return this.cam !== null;
  }

  start(): void {
    const err = this.eds.initialize();
    if (err !== EDS.ERR_OK) throw new Error(`EdsInitializeSDK failed: ${hex(err)}`);
  }

  tick(): void {
    this.pumpEvents();
    const now = this.clock.now();
    if (!this.cam) {
      if (now - this.lastScanAt >= SCAN_INTERVAL_MS) {
        this.lastScanAt = now;
        this.scan();
      }
      return;
    }
    if (now - this.lastKeepAwakeAt >= KEEP_AWAKE_MS) {
      this.lastKeepAwakeAt = now;
      this.check(this.eds.sendCommand(this.cam, EDS.CMD_EXTEND_SHUTDOWN_TIMER, 0), "keep-awake");
    }
    if (this.liveviewOn && !this.capturing && now - this.lastFrameAt >= LIVEVIEW_IDLE_MS) {
      this.setLiveview(false);
    }
  }

  private pumpEvents(): void {
    this.eds.getEvent();
    if (this.shutdownSeen) {
      this.shutdownSeen = false;
      this.disconnect("camera shut down");
    }
  }

  private scan(): void {
    const found = this.eds.firstCamera();
    if (!found) {
      this.emptyScans += 1;
      if (this.emptyScans >= REINIT_AFTER_EMPTY_SCANS) {
        this.emptyScans = 0;
        this.eds.terminate();
        this.eds.initialize();
      }
      return;
    }
    this.emptyScans = 0;
    const cam = found.ref;
    const err = this.eds.openSession(cam);
    if (err !== EDS.ERR_OK) {
      this.log("warn", `Opening a session with ${found.description} failed: ${hex(err)}`);
      this.eds.release(cam);
      return;
    }
    this.cam = cam;
    this.shutdownSeen = false;

    // If a previous worker was killed between a press and its release, the
    // camera is left wedged at 0x81 (busy) until the shutter is released.
    // Do that before anything else touches the session.
    const offErr = this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_OFF);
    if (offErr !== EDS.ERR_OK) this.log("debug", `Shutter release on connect returned ${hex(offErr)}`);

    if (this.setupFailed(this.eds.setObjectHandler(cam, (event, ref) => this.onObject(event, ref)), "set object handler")) return;
    if (
      this.setupFailed(
        this.eds.setStateHandler(cam, (event) => {
          if (event === EDS.STATE_EVENT_SHUTDOWN) this.shutdownSeen = true;
        }),
        "set state handler"
      )
    )
      return;
    // Photos come straight to the PC; nothing is written to the card.
    if (this.setupFailed(this.eds.setU32(cam, EDS.PROP_SAVE_TO, EDS.SAVE_TO_HOST), "set SaveTo=Host")) return;
    if (this.setupFailed(this.eds.setCapacityHost(cam), "set host capacity")) return;
    this.lastKeepAwakeAt = this.clock.now();
    this.log("info", `Connected to ${found.description}`);
    this.emit({ type: "state", connected: true, model: found.description });
  }

  /**
   * Any failure while setting up a just-opened session means the camera
   * isn't usable: drop it so the next scan (after SCAN_INTERVAL_MS) retries,
   * rather than leaving `cam` held with the camera never reported connected.
   */
  private setupFailed(err: number, what: string): boolean {
    if (err === EDS.ERR_OK) return false;
    this.log("warn", `${what} failed: ${hex(err)}`);
    this.disconnect(`session setup failed: ${what} ${hex(err)}`);
    return true;
  }

  private onObject(event: number, ref: EdsRef): void {
    try {
      if (event !== EDS.OBJECT_EVENT_DIR_ITEM_REQUEST_TRANSFER) return;
      const transfer = this.pendingTransfer;
      const { err, item } = this.eds.dirItem(ref);
      if (!transfer || transfer.done || err !== EDS.ERR_OK || !item || !/\.jpe?g$/i.test(item.fileName)) {
        // Nobody is waiting, or it's the RAW half of RAW+JPEG: let the camera move on.
        this.eds.downloadCancel(ref);
        this.log("info", `Skipped transfer of ${item?.fileName ?? "an unreadable item"}`);
        return;
      }
      transfer.err = this.eds.downloadToFile(ref, item.size, transfer.destPath);
      transfer.done = true;
    } finally {
      this.eds.release(ref);
    }
  }

  /** Logs a failed call and drops the session when the error means the camera is gone. Returns err unchanged. */
  private check(err: number, what: string): number {
    if (err === EDS.ERR_OK) return err;
    this.log("warn", `${what} failed: ${hex(err)}`);
    if (DISCONNECT_ERRORS.has(err)) this.disconnect(`${what} returned ${hex(err)}`);
    return err;
  }

  private disconnect(reason: string): void {
    const cam = this.cam;
    if (!cam) return;
    this.cam = null;
    this.liveviewOn = false;
    this.eds.closeSession(cam);
    this.eds.release(cam);
    this.lastScanAt = this.clock.now();
    this.log("warn", `Camera disconnected (${reason})`);
    this.emit({ type: "state", connected: false, model: null });
  }

  private log(level: LogLevel, message: string): void {
    this.emit({ type: "log", level, message });
  }

  async capture(destPath: string): Promise<void> {
    if (!this.cam) throw new Error("No Canon camera connected");
    const transfer = { destPath, done: false, err: EDS.ERR_OK as number };
    this.capturing = true;
    this.pendingTransfer = transfer;
    try {
      let err = await this.press(EDS.SHUTTER_COMPLETELY);
      if (err === EDS.ERR_TAKE_PICTURE_AF_NG) {
        this.log("warn", "Autofocus failed (8D01) - taking this shot without autofocus");
        err = await this.press(EDS.SHUTTER_COMPLETELY_NON_AF);
      }
      if (err !== EDS.ERR_OK) {
        this.check(err, "shutter");
        throw new Error(`Canon shutter failed: ${hex(err)}`);
      }
      const start = this.clock.now();
      while (!transfer.done) {
        if (!this.cam) throw new Error("Camera disconnected during capture");
        if (this.clock.now() - start >= TRANSFER_TIMEOUT_MS) {
          throw new Error("Canon capture timed out waiting for the photo");
        }
        this.pumpEvents();
        if (!transfer.done) await this.clock.sleep(EVENT_POLL_MS);
      }
      if (transfer.err !== EDS.ERR_OK) throw new Error(`Canon photo download failed: ${hex(transfer.err)}`);
    } finally {
      this.capturing = false;
      this.pendingTransfer = null;
    }
  }

  /**
   * One shutter press, ALWAYS followed by a release. digiCamControl skips the
   * release when the press fails, which leaves the R100 answering 0x81 (busy)
   * to everything until it is power-cycled - the bug this worker exists to fix.
   */
  private async press(param: number): Promise<number> {
    const once = (cam: EdsRef): number => {
      const err = this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, param);
      this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_OFF);
      return err;
    };
    const cam = this.cam;
    if (!cam) return EDS.ERR_DEVICE_NOT_FOUND;
    const err = once(cam);
    if (err !== EDS.ERR_DEVICE_BUSY) return err;
    await this.clock.sleep(BUSY_RETRY_DELAY_MS);
    return this.cam ? once(this.cam) : EDS.ERR_DEVICE_NOT_FOUND;
  }

  /** The latest live-view JPEG, or null (no camera, mid-capture, or no frame ready yet). */
  frame(): Buffer | null {
    if (!this.cam || this.capturing) return null;
    this.lastFrameAt = this.clock.now();
    if (!this.liveviewOn && !this.setLiveview(true)) return null;
    const { err, jpeg } = this.eds.downloadEvfFrame(this.cam);
    if (err === EDS.ERR_OBJECT_NOTREADY) return null;
    if (this.check(err, "live view frame") !== EDS.ERR_OK) return null;
    return jpeg;
  }

  /** Flips only the PC bit of Evf_OutputDevice, leaving the camera's own screen as it was. */
  private setLiveview(on: boolean): boolean {
    const cam = this.cam;
    if (!cam) return false;
    const current = this.eds.getU32(cam, EDS.PROP_EVF_OUTPUT_DEVICE);
    if (this.check(current.err, "read live view output") !== EDS.ERR_OK) return false;
    const next = on ? current.value | EDS.EVF_OUTPUT_PC : current.value & ~EDS.EVF_OUTPUT_PC;
    if (this.check(this.eds.setU32(cam, EDS.PROP_EVF_OUTPUT_DEVICE, next >>> 0), "set live view output") !== EDS.ERR_OK) {
      return false;
    }
    this.liveviewOn = on;
    return true;
  }

  shutdown(): void {
    const cam = this.cam;
    if (cam) {
      this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_OFF);
      if (this.liveviewOn) this.setLiveview(false);
      this.eds.closeSession(cam);
      this.eds.release(cam);
      this.cam = null;
    }
    this.eds.terminate();
  }
}
