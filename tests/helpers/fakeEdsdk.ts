import { writeFileSync } from "node:fs";
import { DirItem, EDS, EdsApi, EdsRef } from "../../src/camera/edsdk/edsdkApi";

/**
 * A scriptable stand-in for EDSDK. The camera ref is the string "cam"; a
 * directory item ref is its file name. Events queued by sendCommand/unplug are
 * delivered on the next getEvent(), which is how the real SDK behaves.
 */
export class FakeEds implements EdsApi {
  /** Connected bodies in EDSDK's order. A ref is the body's serial. `held` = another process has its session. */
  bodies: Array<{ name: string; serial: string; held?: boolean }> = [{ name: "Canon EOS R100", serial: "SN-A" }];
  /** Shorthand for "exactly this one body plugged in" (null = none), used by the single-camera tests. */
  get camera(): string | null { return this.bodies[0]?.name ?? null; }
  set camera(name: string | null) { this.bodies = name ? [{ name, serial: "SN-A" }] : []; }
  /** Every ref passed to release(), in order. */
  released: EdsRef[] = [];
  /** Results for successive (non-OFF) shutter presses; once empty, presses succeed. */
  pressResults: number[] = [];
  /** Files a successful full press sends to the host, in order. */
  photoNames: string[] = ["IMG_0001.JPG"];
  evfFrame: { err: number; jpeg: Buffer | null } = { err: 0, jpeg: Buffer.from("frame") };
  evfOutput = 1; // TFT only, as the camera starts
  props = new Map<number, number>();
  /** Every prop code passed to getU32 or getPropertyDesc, in order - lets a test prove properties were (not) read. */
  propReads: number[] = [];
  /** Every prop code passed to setU32, in order (whether or not it succeeded) - lets a test prove a write was (not) attempted. */
  setCalls: number[] = [];
  /** One-shot error results for setU32, keyed by prop; each call shifts one off, then succeeds. */
  setU32Fail = new Map<number, number[]>();
  /** Allowed values per property, as EdsGetPropertyDesc would report; missing = empty (not settable now). */
  descs = new Map<number, number[]>();
  /** Props whose setU32 fails with this error code. */
  rejectSet = new Map<number, number>();
  /** One-shot error results for setObjectHandler; each call shifts one off, then succeeds. */
  objectHandlerResults: number[] = [];
  commands: Array<{ command: number; param: number }> = [];
  calls: string[] = [];
  downloads: Array<{ name: string; path: string }> = [];
  cancels: string[] = [];
  sessionOpen = false;
  private objectHandler: ((event: number, ref: EdsRef) => void) | null = null;
  private stateHandler: ((event: number) => void) | null = null;
  private queued: Array<() => void> = [];

  initialize(): number { this.calls.push("initialize"); return 0; }
  terminate(): number { this.calls.push("terminate"); return 0; }
  cameras(): Array<{ ref: EdsRef; description: string; port: string }> {
    this.calls.push("cameras");
    return this.bodies.map((b) => ({ ref: b.serial, description: b.name, port: `port-${b.serial}` }));
  }
  openSession(cam: EdsRef): number {
    this.calls.push("openSession");
    const body = this.bodies.find((b) => b.serial === cam);
    if (!body || body.held) return EDS.ERR_COMM_PORT_IS_IN_USE;
    this.sessionOpen = true;
    return 0;
  }
  closeSession(): number { this.sessionOpen = false; this.calls.push("closeSession"); return 0; }
  release(ref: EdsRef): void { this.released.push(ref); }
  getString(cam: EdsRef, prop: number): { err: number; value: string } {
    return prop === EDS.PROP_BODY_ID_EX ? { err: 0, value: String(cam) } : { err: 0x50, value: "" };
  }
  getU32(_cam: EdsRef, prop: number): { err: number; value: number } {
    this.propReads.push(prop);
    return { err: 0, value: prop === EDS.PROP_EVF_OUTPUT_DEVICE ? this.evfOutput : this.props.get(prop) ?? 0 };
  }
  setU32(_cam: EdsRef, prop: number, value: number): number {
    this.setCalls.push(prop);
    const reject = this.rejectSet.get(prop);
    if (reject) return reject;
    const queue = this.setU32Fail.get(prop);
    const err = queue && queue.length ? queue.shift()! : 0;
    if (err !== 0) return err;
    if (prop === EDS.PROP_EVF_OUTPUT_DEVICE) this.evfOutput = value;
    else this.props.set(prop, value);
    return 0;
  }
  getPropertyDesc(_cam: EdsRef, prop: number): { err: number; values: number[] } {
    this.propReads.push(prop);
    return { err: 0, values: this.descs.get(prop) ?? [] };
  }
  setCapacityHost(): number { return 0; }
  sendCommand(_cam: EdsRef, command: number, param: number): number {
    this.commands.push({ command, param });
    if (command !== EDS.CMD_PRESS_SHUTTER_BUTTON || param === EDS.SHUTTER_OFF) return 0;
    const err = this.pressResults.shift() ?? 0;
    if (err === 0 && (param === EDS.SHUTTER_COMPLETELY || param === EDS.SHUTTER_COMPLETELY_NON_AF)) {
      for (const name of this.photoNames) {
        this.queued.push(() => this.objectHandler?.(EDS.OBJECT_EVENT_DIR_ITEM_REQUEST_TRANSFER, name));
      }
    }
    return err;
  }
  setObjectHandler(_cam: EdsRef, handler: (event: number, ref: EdsRef) => void): number {
    this.objectHandler = handler;
    return this.objectHandlerResults.shift() ?? 0;
  }
  setStateHandler(_cam: EdsRef, handler: (event: number) => void): number {
    this.stateHandler = handler;
    return 0;
  }
  clearHandlers(): void {
    this.calls.push("clearHandlers");
    this.objectHandler = null;
    this.stateHandler = null;
  }
  getEvent(): void {
    const due = this.queued;
    this.queued = [];
    for (const fire of due) fire();
  }
  downloadEvfFrame(): { err: number; jpeg: Buffer | null } { return this.evfFrame; }
  dirItem(item: EdsRef): { err: number; item: DirItem | null } {
    return { err: 0, item: { size: 3n, fileName: String(item) } };
  }
  downloadToFile(item: EdsRef, _size: bigint, filePath: string): number {
    writeFileSync(filePath, "jpg");
    this.downloads.push({ name: String(item), path: filePath });
    return 0;
  }
  downloadCancel(item: EdsRef): number { this.cancels.push(String(item)); return 0; }

  /** Like pulling the USB cable: the camera vanishes and a Shutdown state event arrives on the next getEvent(). */
  unplug(): void {
    this.camera = null;
    this.queued.push(() => this.stateHandler?.(EDS.STATE_EVENT_SHUTDOWN));
  }

  /** Every PressShutterButton param sent, in order, OFF (0) included. */
  get presses(): number[] {
    return this.commands.filter((c) => c.command === EDS.CMD_PRESS_SHUTTER_BUTTON).map((c) => c.param);
  }
}

/** A clock whose sleep() just moves time forward, so timeouts run instantly in tests. */
export function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}
