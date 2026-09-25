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
    this.eds.setObjectHandler(cam, (event, ref) => this.onObject(event, ref));
    this.eds.setStateHandler(cam, (event) => {
      if (event === EDS.STATE_EVENT_SHUTDOWN) this.shutdownSeen = true;
    });
    // Photos come straight to the PC; nothing is written to the card.
    if (this.check(this.eds.setU32(cam, EDS.PROP_SAVE_TO, EDS.SAVE_TO_HOST), "set SaveTo=Host") !== EDS.ERR_OK) return;
    if (this.check(this.eds.setCapacityHost(cam), "set host capacity") !== EDS.ERR_OK) return;
    this.lastKeepAwakeAt = this.clock.now();
    this.log("info", `Connected to ${found.description}`);
    this.emit({ type: "state", connected: true, model: found.description });
  }

  /** Placeholder until Task 2 handles photo transfers. */
  private onObject(_event: number, _ref: EdsRef): void {}

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
    this.eds.closeSession(cam);
    this.eds.release(cam);
    this.lastScanAt = this.clock.now();
    this.log("warn", `Camera disconnected (${reason})`);
    this.emit({ type: "state", connected: false, model: null });
  }

  private log(level: LogLevel, message: string): void {
    this.emit({ type: "log", level, message });
  }
}
