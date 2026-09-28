import { DISCONNECT_ERRORS, EDS, EdsApi, EdsRef, hex } from "./edsdkApi";
import { aeModeLabel, afModeLabel, batteryLevel, imageQuality, SettingKey, settingLabel } from "./cameraLabels";
import { CameraDetail, CameraSettings, LogLevel, SettingChanges, WorkerEvent } from "./protocol";

const SETTING_PROPS: Record<SettingKey, number> = {
  iso: EDS.PROP_ISO, av: EDS.PROP_AV, tv: EDS.PROP_TV,
  wb: EDS.PROP_WHITE_BALANCE, ev: EDS.PROP_EXPOSURE_COMP, quality: EDS.PROP_IMAGE_QUALITY,
};
const SETTING_KEYS = Object.keys(SETTING_PROPS) as SettingKey[];

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Which camera body a worker owns: `serial` (null = the first free body), never `avoid` (the other slot's body). */
export interface CameraTarget {
  serial: string | null;
  avoid: string | null;
}

const SCAN_INTERVAL_MS = 1_000;
// Opening a body another process holds blocks for ~3 s before failing (0xC0,
// measured on two R100s), so a held port is only retried this often.
const HELD_RETRY_MS = 15_000;
// EdsGetCameraList in a long-lived process may not notice a re-plugged
// camera; re-initializing the SDK now and then forces a fresh device list.
const REINIT_AFTER_EMPTY_SCANS = 5;
const KEEP_AWAKE_MS = 60_000;
const BUSY_RETRY_DELAY_MS = 500;
// The whole capture, press included, must give up just before the agent's
// 12 s request timeout, so a photo never lands after the agent stopped waiting.
const CAPTURE_DEADLINE_MS = 11_000;
const EVENT_POLL_MS = 30;
const LIVEVIEW_IDLE_MS = 10_000;
const PREFOCUS_HOLD_MS = 3_000;
const STATUS_POLL_MS = 5_000;
// A failure that repeats (a session another program holds, live view refused
// on every frame) is logged and recorded once per this window, not every time.
const REPEAT_QUIET_MS = 60_000;

/**
 * Everything the camera worker process does with the Canon, written against
 * EdsApi so it can be tested without a camera. Runs on the worker's single
 * thread: tick() is called every ~30 ms by worker.ts, and every EDSDK call
 * (including the event handlers, which fire inside getEvent()) happens there.
 */
export class CameraWorker {
  private cam: EdsRef | null = null;
  /** The connected body's serial (kEdsPropID_BodyIDEx), or null. */
  private serial: string | null = null;
  /** Serial read from each USB port, so a body that isn't ours is not re-opened every scan. */
  private readonly portSerials = new Map<string, string>();
  /** Ports whose body another process held, and when to try them again. */
  private readonly heldUntil = new Map<string, number>();
  /** The sorted port list of the last scan; a change clears the two maps above. */
  private lastPorts = "";
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
  /** When the pre-focus half-press started, or null when the shutter isn't held. */
  private halfPressedAt: number | null = null;
  private lastStatusAt = 0;
  private lastError: CameraDetail["lastError"] = null;
  /** JSON of the last status sent, so an unchanged poll sends nothing. */
  private lastStatusSent = "";
  /** The last property readings taken; held steady during a capture so recordError() never touches EDSDK mid-shot. */
  private lastReadings: Omit<CameraDetail, "lastError"> = { battery: null, mode: null, afMode: null, quality: null };
  /** Whether the agent has heard the outcome of the first scan (connected or not). */
  private announced = false;
  /** Last time each warning was logged, keyed by its text. */
  private readonly lastWarnAt = new Map<string, number>();

  constructor(
    private readonly eds: EdsApi,
    private readonly emit: (event: WorkerEvent) => void,
    private readonly clock: Clock = realClock,
    private readonly target: CameraTarget = { serial: null, avoid: null }
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
        // Let the agent stop waiting at startup: no camera is an answer too.
        if (!this.announced && !this.cam) this.emit({ type: "state", connected: false, model: null, serial: null });
        this.announced = true;
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
    // A guest who tapped ✕, or a kiosk that went away, must not leave the shutter half-pressed.
    if (this.halfPressedAt !== null && !this.capturing && now - this.halfPressedAt >= PREFOCUS_HOLD_MS) {
      this.halfPressedAt = null;
      this.check(this.eds.sendCommand(this.cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_OFF), "pre-focus release");
    }
    if (!this.capturing && now - this.lastStatusAt >= STATUS_POLL_MS) {
      this.lastStatusAt = now;
      this.publishStatus();
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
    const found = this.eds.cameras();
    if (found.length === 0) {
      this.emptyScans += 1;
      if (this.emptyScans >= REINIT_AFTER_EMPTY_SCANS) {
        this.emptyScans = 0;
        this.eds.terminate();
        this.eds.initialize();
      }
      return;
    }
    this.emptyScans = 0;
    // A replug (or a cable moved to another port) changes the set of ports: start over.
    const ports = found.map((c) => c.port).sort().join("|");
    if (ports !== this.lastPorts) {
      this.lastPorts = ports;
      this.portSerials.clear();
      this.heldUntil.clear();
    }
    const now = this.clock.now();
    let picked: { ref: EdsRef; description: string; serial: string } | null = null;
    for (const { ref, description, port } of found) {
      const known = this.portSerials.get(port);
      const skip: boolean = !!picked || (known !== undefined && !this.isMine(known)) || (this.heldUntil.get(port) ?? 0) > now;
      const serial: string | null = skip ? null : this.claim(ref, description, port);
      if (serial === null) {
        this.eds.release(ref);
        continue;
      }
      picked = { ref, description, serial };
    }
    if (!picked) return;
    const cam = picked.ref;
    this.cam = cam;
    this.serial = picked.serial;
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
    this.log("info", `Connected to ${picked.description}`);
    this.emit({ type: "state", connected: true, model: picked.description, serial: this.serial });
    this.lastStatusAt = this.clock.now();
    this.publishStatus();
  }

  /**
   * Opens `ref` and returns its serial if this worker should own it, else null
   * (session closed again; the caller releases the ref). A body another
   * worker holds fails to open and is simply skipped.
   */
  private claim(ref: EdsRef, description: string, port: string): string | null {
    const err = this.eds.openSession(ref);
    if (err !== EDS.ERR_OK) {
      // Most likely the other slot's worker holds it; opening it again costs ~3 s of blocking.
      this.heldUntil.set(port, this.clock.now() + HELD_RETRY_MS);
      this.warn(`Opening a session with ${description} failed: ${hex(err)}`);
      return null;
    }
    const id = this.eds.getString(ref, EDS.PROP_BODY_ID_EX);
    const serial = id.err === EDS.ERR_OK ? id.value : "";
    this.portSerials.set(port, serial);
    if (!this.isMine(serial)) {
      this.eds.closeSession(ref);
      return null;
    }
    return serial;
  }

  private isMine(serial: string): boolean {
    return this.target.serial ? serial === this.target.serial : !(this.target.avoid && serial === this.target.avoid);
  }

  /**
   * Any failure while setting up a just-opened session means the camera
   * isn't usable: drop it so the next scan (after SCAN_INTERVAL_MS) retries,
   * rather than leaving `cam` held with the camera never reported connected.
   */
  private setupFailed(err: number, what: string): boolean {
    if (err === EDS.ERR_OK) return false;
    this.warn(`${what} failed: ${hex(err)}`);
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
    this.warn(`${what} failed: ${hex(err)}`);
    if (DISCONNECT_ERRORS.has(err)) this.disconnect(`${what} returned ${hex(err)}`);
    return err;
  }

  private disconnect(reason: string): void {
    const cam = this.cam;
    if (!cam) return;
    this.cam = null;
    this.serial = null;
    this.liveviewOn = false;
    this.halfPressedAt = null;
    this.closeCamera(cam);
    this.lastScanAt = this.clock.now();
    // No camera to read from any more, whether or not a capture is still unwinding.
    this.lastReadings = { battery: null, mode: null, afMode: null, quality: null };
    this.warn(`Camera disconnected (${reason})`);
    this.emit({ type: "state", connected: false, model: null, serial: null });
    this.recordError(`Camera disconnected (${reason})`);
  }

  /** Unhooks our callbacks first, so EDSDK can't call into a handler for a closed session. */
  private closeCamera(cam: EdsRef): void {
    this.eds.clearHandlers(cam);
    this.eds.closeSession(cam);
    this.eds.release(cam);
  }

  private log(level: LogLevel, message: string): void {
    this.emit({ type: "log", level, message });
  }

  /** A warning, but the same text at most once per REPEAT_QUIET_MS. */
  private warn(message: string): void {
    const now = this.clock.now();
    const last = this.lastWarnAt.get(message);
    if (last !== undefined && now - last < REPEAT_QUIET_MS) return;
    this.lastWarnAt.set(message, now);
    this.log("warn", message);
  }

  /**
   * The worker must never touch EDSDK while a capture is in flight (that's
   * the shutter/transfer's exclusive access), so a capture-time status -
   * the AF-fallback notice, a thrown failure - reuses the last readings
   * taken instead of reading fresh ones.
   */
  private readStatus(): Omit<CameraDetail, "lastError"> {
    if (this.capturing) return this.lastReadings;
    const cam = this.cam;
    if (!cam) {
      this.lastReadings = { battery: null, mode: null, afMode: null, quality: null };
      return this.lastReadings;
    }
    const read = (prop: number) => {
      const r = this.eds.getU32(cam, prop);
      return r.err === EDS.ERR_OK ? r.value : null;
    };
    const battery = read(EDS.PROP_BATTERY_LEVEL);
    const mode = read(EDS.PROP_AE_MODE);
    const af = read(EDS.PROP_AF_MODE);
    const quality = read(EDS.PROP_IMAGE_QUALITY);
    this.lastReadings = {
      battery: battery === null ? null : batteryLevel(battery),
      mode: mode === null ? null : aeModeLabel(mode),
      afMode: af === null ? null : afModeLabel(af),
      quality: quality === null ? null : imageQuality(quality),
    };
    return this.lastReadings;
  }

  /** Sends the current status if it differs from the last one sent. */
  private publishStatus(): void {
    const detail: CameraDetail = { ...this.readStatus(), lastError: this.lastError };
    const json = JSON.stringify(detail);
    if (json === this.lastStatusSent) return;
    this.lastStatusSent = json;
    this.emit({ type: "status", detail });
  }

  /** Remembers a problem an operator should see on the Status tab, and publishes it. */
  private recordError(message: string): void {
    const now = this.clock.now();
    // A retry loop failing the same way every second shouldn't re-send status each time.
    if (this.lastError?.message === message && now - Date.parse(this.lastError.at) < REPEAT_QUIET_MS) return;
    this.lastError = { message, at: new Date(now).toISOString() };
    this.publishStatus();
  }

  async capture(destPath: string): Promise<void> {
    if (!this.cam) throw new Error("No Canon camera connected");
    const transfer = { destPath, done: false, err: EDS.ERR_OK as number };
    this.capturing = true;
    this.halfPressedAt = null; // the full press takes over; press() releases afterwards
    this.pendingTransfer = transfer;
    const start = this.clock.now();
    try {
      let err = await this.press(EDS.SHUTTER_COMPLETELY);
      if (err === EDS.ERR_TAKE_PICTURE_AF_NG) {
        this.log("warn", "Autofocus failed (8D01) - taking this shot without autofocus");
        this.recordError("Autofocus failed - took the shot without autofocus");
        err = await this.press(EDS.SHUTTER_COMPLETELY_NON_AF);
      }
      if (err !== EDS.ERR_OK) {
        this.check(err, "shutter");
        throw new Error(`Canon shutter failed: ${hex(err)}`);
      }
      while (!transfer.done) {
        if (!this.cam) throw new Error("Camera disconnected during capture");
        if (this.clock.now() - start >= CAPTURE_DEADLINE_MS) {
          throw new Error("Canon capture timed out waiting for the photo");
        }
        this.pumpEvents();
        if (!transfer.done) await this.clock.sleep(EVENT_POLL_MS);
      }
      if (transfer.err !== EDS.ERR_OK) throw new Error(`Canon photo download failed: ${hex(transfer.err)}`);
    } catch (err) {
      // After a disconnect, lastError already says why - more useful than "shutter failed".
      if (this.cam) this.recordError(err instanceof Error ? err.message : String(err));
      throw err;
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

  /**
   * Half-presses the shutter so AF has already locked when the countdown hits
   * zero (the kiosk calls this ~1.5 s early). Purely an optimisation: capture()
   * presses fully either way, and its OFF releases this hold too.
   */
  prefocus(): void {
    const cam = this.cam;
    if (!cam || this.capturing) return;
    const err = this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_HALFWAY);
    if (err !== EDS.ERR_OK) {
      this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_OFF);
      this.check(err, "pre-focus");
      return;
    }
    this.halfPressedAt = this.clock.now();
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

  private settingsCam(): EdsRef {
    if (!this.cam) throw new Error("No Canon camera connected");
    // A backstop only: EdsdkSource's captureLock already keeps settings calls
    // from overlapping a capture.
    if (this.capturing) throw new Error("Camera is busy capturing");
    return this.cam;
  }

  /** Current value and allowed options for each setting the operator panel can change. */
  getSettings(rejected: SettingKey[] = []): CameraSettings {
    const cam = this.settingsCam();
    const mode = this.eds.getU32(cam, EDS.PROP_AE_MODE);
    const settings = {} as CameraSettings["settings"];
    for (const key of SETTING_KEYS) {
      const prop = SETTING_PROPS[key];
      const current = this.eds.getU32(cam, prop);
      const desc = this.eds.getPropertyDesc(cam, prop);
      settings[key] = {
        value: current.err === EDS.ERR_OK ? { code: current.value, label: settingLabel(key, current.value) } : null,
        options: (desc.err === EDS.ERR_OK ? desc.values : []).map((code) => ({ code, label: settingLabel(key, code) })),
      };
    }
    return { mode: mode.err === EDS.ERR_OK ? aeModeLabel(mode.value) : null, settings, rejected };
  }

  /** Applies each change the camera allows in its current mode; the rest come back in `rejected`. */
  setSettings(changes: SettingChanges): CameraSettings {
    const cam = this.settingsCam();
    const rejected: SettingKey[] = [];
    for (const key of SETTING_KEYS) {
      const code = changes[key];
      if (code === undefined) continue;
      const prop = SETTING_PROPS[key];
      const allowed = this.eds.getPropertyDesc(cam, prop);
      const err = allowed.err === EDS.ERR_OK && allowed.values.includes(code >>> 0) ? this.eds.setU32(cam, prop, code >>> 0) : -1;
      if (err !== EDS.ERR_OK) {
        rejected.push(key);
        if (err !== -1) this.check(err, `set ${key}`);
        // check() may have disconnected (closed and released `cam`): stop touching
        // the now-invalid handle for the remaining keys. getSettings() below then
        // throws "No Canon camera connected", the right outcome for the caller.
        if (!this.cam) break;
      }
    }
    return this.getSettings(rejected);
  }

  shutdown(): void {
    const cam = this.cam;
    if (cam) {
      this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_OFF);
      if (this.liveviewOn) this.setLiveview(false);
      this.closeCamera(cam);
      this.cam = null;
    }
    this.eds.terminate();
  }
}
