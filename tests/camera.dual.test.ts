import { describe, it, expect, afterEach } from "vitest";
import { CameraManager } from "../src/camera/CameraManager";
import { CameraSource, CameraUnavailableError, CaptureResult } from "../src/camera/CameraSource";
import { EventBus } from "../src/events/eventBus";
import { BoothEvent } from "../src/events/types";

class Fake implements CameraSource {
  healthy = true;
  failCapture = false;
  restarted = 0;
  prefocused = 0;
  constructor(readonly kind: "canon" | "webcam", readonly name: string, private readonly serial: string | null = null) {}
  async initialize() { return this.healthy; }
  async shutdown() {}
  async isHealthy() { return this.healthy; }
  async capture(): Promise<CaptureResult> {
    if (this.failCapture) throw new Error(`${this.name} failed`);
    return { filePath: `/tmp/${this.name}.jpg`, width: 1, height: 1 };
  }
  async getLiveviewFrame() { return this.healthy ? Buffer.from(this.name) : null; }
  async prefocus() { this.prefocused += 1; }
  getModel() { return this.name; }
  getSerial() { return this.serial; }
  restart() { this.restarted += 1; }
  async getSettings() { return { mode: this.name, settings: {} as never, rejected: [] }; }
  async setSettings() { return { mode: this.name, settings: {} as never, rejected: [] }; }
}

const waitUntil = async (p: () => boolean) => {
  const start = Date.now();
  while (!p()) {
    if (Date.now() - start > 2000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let manager: CameraManager | undefined;
afterEach(async () => { await manager?.stop(); manager = undefined; });

async function setup(opts: { withLow?: boolean } = {}) {
  const high = new Fake("canon", "high", "SN-A");
  const low = new Fake("canon", "low", "SN-B");
  const webcam = new Fake("webcam", "webcam");
  const eventBus = new EventBus();
  const events: BoothEvent[] = [];
  eventBus.subscribe((e) => events.push(e));
  manager = new CameraManager(
    { canon: high, webcam, ...(opts.withLow === false ? {} : { canonLow: low }) },
    "canon", eventBus, 20
  );
  await manager.start();
  return { high, low, webcam, manager, events };
}

describe("CameraManager with a low camera", () => {
  it("emits camera-disconnected and camera-recovered for the low camera, tagged camera: low", async () => {
    const { manager, low, events } = await setup();
    low.healthy = false;
    await waitUntil(() => !manager.getStatus().low!.connected);
    low.healthy = true;
    await waitUntil(() => manager.getStatus().low!.connected);
    const cameraEvents = events.filter((e) => e.type === "camera-disconnected" || e.type === "camera-recovered");
    expect(cameraEvents).toEqual([
      { type: "camera-disconnected", source: "canon", camera: "low" },
      { type: "camera-recovered", source: "canon", camera: "low" },
    ]);
  });

  it("tags the high Canon's events camera: high", async () => {
    const { manager, high, events } = await setup();
    high.healthy = false;
    await waitUntil(() => !manager.getStatus().canonConnected);
    expect(events).toContainEqual({ type: "camera-disconnected", source: "canon", camera: "high" });
  });

  it("captures on the camera asked for, high by default", async () => {
    const { manager } = await setup();
    expect(await manager.capture("/tmp")).toMatchObject({ camera: "high", source: "canon", filePath: "/tmp/high.jpg" });
    expect(await manager.capture("/tmp", "low")).toMatchObject({ camera: "low", source: "canon", filePath: "/tmp/low.jpg" });
  });

  it("falls back low -> high -> webcam", async () => {
    const { manager, low, high } = await setup();
    low.failCapture = true;
    expect(await manager.capture("/tmp", "low")).toMatchObject({ camera: "high" });
    high.failCapture = true;
    expect(await manager.capture("/tmp", "low")).toMatchObject({ camera: "webcam", source: "webcam" });
  });

  it("serves a high request from the low camera when the high one is down", async () => {
    const { manager, high } = await setup();
    high.healthy = false;
    await waitUntil(() => manager.getStatus().canonConnected === false);
    expect(await manager.capture("/tmp")).toMatchObject({ camera: "low", source: "canon", filePath: "/tmp/low.jpg" });
    expect((await manager.getLiveviewFrame())?.frame.toString()).toBe("low");
  });

  it("serves a low request from the high camera when there is no low slot (digiCamControl)", async () => {
    const { manager } = await setup({ withLow: false });
    expect(await manager.capture("/tmp", "low")).toMatchObject({ camera: "high" });
    expect(manager.getStatus().low).toBeNull();
  });

  it("routes live view and pre-focus like the capture", async () => {
    const { manager, low, high } = await setup();
    expect((await manager.getLiveviewFrame("low"))?.frame.toString()).toBe("low");
    await manager.prefocus("low");
    expect(low.prefocused).toBe(1);
    low.healthy = false;
    await waitUntil(() => manager.getStatus().low?.connected === false);
    expect((await manager.getLiveviewFrame("low"))?.frame.toString()).toBe("high");
    await manager.prefocus("low");
    expect(high.prefocused).toBe(1);
  });

  it("captureExact never falls back", async () => {
    const { manager, low } = await setup();
    low.healthy = false;
    await waitUntil(() => manager.getStatus().low?.connected === false);
    await expect(manager.captureExact("/tmp", "low")).rejects.toBeInstanceOf(CameraUnavailableError);
    const first = manager!;
    const noLow = await setup({ withLow: false });
    await expect(noLow.manager.captureExact("/tmp", "low")).rejects.toThrow(/EDSDK/);
    await first.stop();
  });

  it("settings go to the named camera", async () => {
    const { manager } = await setup();
    expect((await manager.getCanonSettings("low")).mode).toBe("low");
    expect((await manager.setCanonSettings({}, "high")).mode).toBe("high");
  });

  it("reports both cameras and restarts both workers", async () => {
    const { manager, high, low } = await setup();
    expect(manager.getStatus()).toMatchObject({
      canonModel: "high", canonSerial: "SN-A",
      low: { connected: true, model: "low", serial: "SN-B", detail: null },
    });
    manager.restartCanonWorkers();
    expect([high.restarted, low.restarted]).toEqual([1, 1]);
  });
});
