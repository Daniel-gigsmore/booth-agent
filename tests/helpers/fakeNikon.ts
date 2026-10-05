import { writeFileSync } from "node:fs";
import path from "node:path";
import { NikonApi, NikonDevice, NikonHandlers } from "../../src/camera/nikon/nikonApi";
import { NK, NikonEnumHeader, NikonEnumValue, NikonRange } from "../../src/camera/nikon/nikonLayout";

/** A Nikon SDK stand-in: one Z 30, shots that write a file into the shot folder. */
export class FakeNikon implements NikonApi {
  handlers: NikonHandlers | null = null;
  devicesList: NikonDevice[] = [{ id: 7, name: "Z 30", available: true }];
  calls: string[] = [];
  initErr: number = NK.OK;
  connectErr: number = NK.OK;
  battery = 80;
  saveMedia: number | null = null;
  /** Results for successive shoot() calls; once used up, shots succeed. */
  shootResults: number[] = [];
  /** What a successful shot leaves in the folder. */
  shotFiles: string[] = ["DSC_0001.JPG"];
  /** Set false to have a successful shot write nothing (the photo never arrives). */
  writeFiles = true;
  /** Whether a shot reports each file with an ImageSaved event, like the real SDK. */
  announceSaved = false;
  shots: Array<{ dir: string; autoFocus: boolean }> = [];
  /** Runs inside every shot, e.g. to fire an SDK event mid-capture. */
  onShoot: (() => void) | null = null;
  /** Enum settings by capability; a capability that is absent answers CapabilityNotSupported. */
  enums = new Map<number, NikonEnumValue>([
    [NK.CAP_SENSITIVITY, { type: NK.ARRAY_PACKED_STRING, elements: 0, def: 0, physicalBytes: 1, value: 1, options: ["ISO 100", "ISO 200", "ISO 400"] }],
    [NK.CAP_APERTURE, { type: NK.ARRAY_PACKED_STRING, elements: 0, def: 0, physicalBytes: 1, value: 0, options: ["f/3.5", "f/5.6"] }],
    [NK.CAP_EXPOSURE_MODE, { type: NK.ARRAY_UNSIGNED, elements: 0, def: 0, physicalBytes: 4, value: 3, options: [0, 1, 2, 3] }],
  ]);
  ranges = new Map<number, NikonRange>([
    [NK.CAP_EXPOSURE_COMP, { value: 0, def: 0, valueIndex: 2, defaultIndex: 2, lower: -0.6, upper: 0.6, steps: 5 }],
  ]);
  /** Capabilities whose next set fails, mapped to the error. */
  setErrors = new Map<number, number>();
  /** Everything set, in order: [capability, index]. */
  sets: Array<[number, number]> = [];
  /** When non-zero, every settings read fails with this. */
  readErr = 0;
  liveviewErr: number = NK.OK;
  liveview = false;
  terminated = false;

  async initialize(handlers: NikonHandlers): Promise<number> {
    this.calls.push("initialize");
    this.handlers = handlers;
    return this.initErr;
  }
  async devices() {
    this.calls.push("devices");
    return { err: NK.OK, devices: this.devicesList.map((d) => ({ ...d })) };
  }
  async connect(id: number) {
    this.calls.push(`connect:${id}`);
    return this.connectErr;
  }
  async disconnect() {
    this.calls.push("disconnect");
  }
  async setUnsigned(capability: number, value: number) {
    if (capability === NK.CAP_SAVE_MEDIA) this.saveMedia = value;
    return NK.OK;
  }
  async getInteger(capability: number) {
    return capability === NK.CAP_BATTERY_LEVEL ? { err: NK.OK, value: this.battery } : { err: -107, value: 0 };
  }
  async getEnum(capability: number) {
    if (this.readErr) return { err: this.readErr, enum: null };
    const e = this.enums.get(capability);
    return e ? { err: NK.OK, enum: { ...e, options: [...e.options] } } : { err: -107, enum: null };
  }
  async setEnum(capability: number, _header: NikonEnumHeader, index: number) {
    const err = this.setErrors.get(capability);
    if (err !== undefined) {
      this.setErrors.delete(capability);
      return err;
    }
    this.sets.push([capability, index]);
    const e = this.enums.get(capability);
    if (e) e.value = index;
    return NK.OK;
  }
  async getRange(capability: number) {
    if (this.readErr) return { err: this.readErr, range: null };
    const r = this.ranges.get(capability);
    return r ? { err: NK.OK, range: { ...r } } : { err: -107, range: null };
  }
  async setRange(capability: number, range: NikonRange) {
    const err = this.setErrors.get(capability);
    if (err !== undefined) {
      this.setErrors.delete(capability);
      return err;
    }
    this.sets.push([capability, range.valueIndex]);
    this.ranges.set(capability, { ...range });
    return NK.OK;
  }
  async shoot(dir: string, autoFocus: boolean) {
    this.shots.push({ dir, autoFocus });
    this.onShoot?.();
    const err = this.shootResults.shift() ?? NK.OK;
    if (err === NK.OK && this.writeFiles) {
      for (const name of this.shotFiles) {
        writeFileSync(path.join(dir, name), Buffer.from(`photo ${name}`));
        if (this.announceSaved) this.handlers?.onImageSaved(path.join(dir, name));
      }
    }
    return err;
  }
  async startLiveView() {
    this.calls.push("startLiveView");
    if (this.liveviewErr === NK.OK) this.liveview = true;
    return this.liveviewErr;
  }
  async stopLiveView() {
    this.calls.push("stopLiveView");
    this.liveview = false;
    return NK.OK;
  }
  async terminate() {
    this.terminated = true;
  }

  /** The SDK pushing a frame / event from its thread. */
  frame(jpeg: Buffer) {
    this.handlers?.onLiveViewFrame(jpeg);
  }
  event(event: number, param = 0n) {
    this.handlers?.onEvent(event, param);
  }
}
