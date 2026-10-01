import { writeFileSync } from "node:fs";
import path from "node:path";
import { NikonApi, NikonDevice, NikonHandlers } from "../../src/camera/nikon/nikonApi";
import { NK } from "../../src/camera/nikon/nikonLayout";

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
