import { writeFileSync } from "node:fs";
import { DirItem, EDS, EdsApi, EdsRef } from "../../src/camera/edsdk/edsdkApi";

/**
 * A scriptable stand-in for EDSDK. The camera ref is the string "cam"; a
 * directory item ref is its file name. Events queued by sendCommand/unplug are
 * delivered on the next getEvent(), which is how the real SDK behaves.
 */
export class FakeEds implements EdsApi {
  /** What firstCamera() finds: a model name, or null for "nothing plugged in". */
  camera: string | null = "Canon EOS R100";
  /** Results for successive (non-OFF) shutter presses; once empty, presses succeed. */
  pressResults: number[] = [];
  /** Files a successful full press sends to the host, in order. */
  photoNames: string[] = ["IMG_0001.JPG"];
  evfFrame: { err: number; jpeg: Buffer | null } = { err: 0, jpeg: Buffer.from("frame") };
  evfOutput = 1; // TFT only, as the camera starts
  props = new Map<number, number>();
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
  firstCamera(): { ref: EdsRef; description: string } | null {
    this.calls.push("firstCamera");
    return this.camera ? { ref: "cam", description: this.camera } : null;
  }
  openSession(): number { this.sessionOpen = true; this.calls.push("openSession"); return 0; }
  closeSession(): number { this.sessionOpen = false; this.calls.push("closeSession"); return 0; }
  release(): void {}
  getU32(_cam: EdsRef, prop: number): { err: number; value: number } {
    return { err: 0, value: prop === EDS.PROP_EVF_OUTPUT_DEVICE ? this.evfOutput : this.props.get(prop) ?? 0 };
  }
  setU32(_cam: EdsRef, prop: number, value: number): number {
    if (prop === EDS.PROP_EVF_OUTPUT_DEVICE) this.evfOutput = value;
    else this.props.set(prop, value);
    return 0;
  }
  setCapacityHost(): number { return 0; }
  sendCommand(_cam: EdsRef, command: number, param: number): number {
    this.commands.push({ command, param });
    if (command !== EDS.CMD_PRESS_SHUTTER_BUTTON || param === EDS.SHUTTER_OFF) return 0;
    const err = this.pressResults.shift() ?? 0;
    if (err === 0) {
      for (const name of this.photoNames) {
        this.queued.push(() => this.objectHandler?.(EDS.OBJECT_EVENT_DIR_ITEM_REQUEST_TRANSFER, name));
      }
    }
    return err;
  }
  setObjectHandler(_cam: EdsRef, handler: (event: number, ref: EdsRef) => void): number {
    this.objectHandler = handler;
    return 0;
  }
  setStateHandler(_cam: EdsRef, handler: (event: number) => void): number {
    this.stateHandler = handler;
    return 0;
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
