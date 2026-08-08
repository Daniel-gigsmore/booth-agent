import { describe, it, expect, afterEach } from "vitest";
import { CameraManager } from "../src/camera/CameraManager";
import { CameraSource, CaptureResult } from "../src/camera/CameraSource";
import { EventBus } from "../src/events/eventBus";
import { BoothEvent } from "../src/events/types";

class FakeCameraSource implements CameraSource {
  healthy = true;
  captureShouldFail = false;
  initCount = 0;

  constructor(readonly kind: "canon" | "webcam", private readonly model: string) {}

  async initialize(): Promise<boolean> {
    this.initCount += 1;
    return this.healthy;
  }
  async shutdown(): Promise<void> {}
  async isHealthy(): Promise<boolean> {
    return this.healthy;
  }
  async capture(_destDir: string): Promise<CaptureResult> {
    if (this.captureShouldFail) throw new Error(`${this.kind} capture failed`);
    return { filePath: `/tmp/${this.kind}.jpg`, width: 100, height: 100 };
  }
  async getLiveviewFrame(): Promise<Buffer | null> {
    return this.healthy ? Buffer.from("frame") : null;
  }
  getModel(): string | null {
    return this.model;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe("CameraManager fallback and recovery", () => {
  let manager: CameraManager | undefined;

  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
  });

  it("starts on the preferred Canon source when both are healthy", async () => {
    const canon = new FakeCameraSource("canon", "Canon EOS R100");
    const webcam = new FakeCameraSource("webcam", "USB Webcam");
    manager = new CameraManager({ canon, webcam }, "canon", new EventBus(), 20);
    await manager.start();

    expect(manager.getStatus().activeSource).toBe("canon");
  });

  it("falls back to webcam when Canon goes unhealthy, and emits camera-fallback", async () => {
    const canon = new FakeCameraSource("canon", "Canon EOS R100");
    const webcam = new FakeCameraSource("webcam", "USB Webcam");
    const eventBus = new EventBus();
    const events: BoothEvent[] = [];
    eventBus.subscribe((e) => events.push(e));

    manager = new CameraManager({ canon, webcam }, "canon", eventBus, 20);
    await manager.start();
    expect(manager.getStatus().activeSource).toBe("canon");

    canon.healthy = false; // simulate unplug
    const fellBackAt = Date.now();
    await waitUntil(() => manager!.getStatus().activeSource === "webcam");
    const detectionMs = Date.now() - fellBackAt;

    expect(detectionMs).toBeLessThan(3000);
    expect(events.some((e) => e.type === "camera-fallback" && e.to === "webcam")).toBe(true);
    expect(events.some((e) => e.type === "camera-disconnected" && e.source === "canon")).toBe(true);
  });

  it("returns to Canon automatically once it reconnects, without recreating the manager", async () => {
    const canon = new FakeCameraSource("canon", "Canon EOS R100");
    const webcam = new FakeCameraSource("webcam", "USB Webcam");
    manager = new CameraManager({ canon, webcam }, "canon", new EventBus(), 20);
    await manager.start();

    canon.healthy = false;
    await waitUntil(() => manager!.getStatus().activeSource === "webcam");

    canon.healthy = true; // simulate replug
    await waitUntil(() => manager!.getStatus().activeSource === "canon");

    expect(manager.getStatus().activeSource).toBe("canon");
  });

  it("keeps /capture working through a fallback: a mid-flight Canon failure retries on webcam", async () => {
    const canon = new FakeCameraSource("canon", "Canon EOS R100");
    const webcam = new FakeCameraSource("webcam", "USB Webcam");
    manager = new CameraManager({ canon, webcam }, "canon", new EventBus(), 20);
    await manager.start();

    canon.captureShouldFail = true;
    const result = await manager.capture("/tmp");

    expect(result.source).toBe("webcam");
    expect(manager.getStatus().activeSource).toBe("webcam");
  });

  it("never stops the show: capture still works when only webcam is available from the start", async () => {
    const canon = new FakeCameraSource("canon", "Canon EOS R100");
    canon.healthy = false;
    const webcam = new FakeCameraSource("webcam", "USB Webcam");
    manager = new CameraManager({ canon, webcam }, "canon", new EventBus(), 20);
    await manager.start();

    expect(manager.getStatus().activeSource).toBe("webcam");
    const result = await manager.capture("/tmp");
    expect(result.source).toBe("webcam");
  });
});
