import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { CameraManager } from "../src/camera/CameraManager";
import { CameraSource } from "../src/camera/CameraSource";
import { EventBus } from "../src/events/eventBus";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";

function fakeSource(kind: "canon" | "webcam", prefocus?: () => Promise<void>): CameraSource {
  return {
    kind,
    initialize: async () => true,
    shutdown: async () => {},
    isHealthy: async () => true,
    capture: async () => ({ filePath: "x.jpg", width: 1, height: 1 }),
    getLiveviewFrame: async () => null,
    getModel: () => kind,
    ...(prefocus ? { prefocus } : {}),
  };
}

describe("CameraManager.prefocus", () => {
  it("forwards to the active source", async () => {
    const prefocus = vi.fn(async () => {});
    const manager = new CameraManager({ canon: fakeSource("canon", prefocus), webcam: fakeSource("webcam") }, "canon", new EventBus(), 60_000);
    await manager.start();
    await manager.prefocus();
    expect(prefocus).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("is a no-op for a source without pre-focus, and never rejects", async () => {
    const failing = new CameraManager(
      { canon: fakeSource("canon", async () => { throw new Error("worker gone"); }), webcam: fakeSource("webcam") },
      "canon", new EventBus(), 60_000
    );
    await failing.start();
    await expect(failing.prefocus()).resolves.toBeUndefined();
    await failing.stop();

    const webcamOnly = new CameraManager({ canon: fakeSource("canon"), webcam: fakeSource("webcam") }, "webcam", new EventBus(), 60_000);
    await webcamOnly.start();
    await expect(webcamOnly.prefocus()).resolves.toBeUndefined();
    await webcamOnly.stop();
  });
});

describe("POST /camera/prefocus", () => {
  const SECRET = "test-secret";
  const prefocus = vi.fn(async () => {});
  let server: Server;
  let base: string;

  beforeAll(() => {
    const ctx = {
      configStore: { current: { agent: { allowedOrigins: [], sharedSecret: SECRET } } },
      cameraManager: { prefocus },
    } as unknown as AgentContext;
    server = buildHttpApp(ctx).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it("answers 202 and asks the camera to pre-focus", async () => {
    const res = await fetch(`${base}/camera/prefocus`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(202);
    expect(prefocus).toHaveBeenCalledTimes(1);
  });

  it("still answers 202 when pre-focus fails", async () => {
    prefocus.mockRejectedValueOnce(new Error("boom"));
    const res = await fetch(`${base}/camera/prefocus`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(202);
  });
});
