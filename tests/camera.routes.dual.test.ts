import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import sharp from "sharp";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";
import { CameraUnavailableError } from "../src/camera/CameraSource";
import { readCameraSerials, writeCameraSerials } from "../src/camera/camerasStore";
import { readSavedCameraSettings } from "../src/camera/cameraSettingsStore";

const SECRET = "test-secret";
const dataDir = mkdtempSync(path.join(tmpdir(), "dualroutes-"));
const jpeg = async (dir: string) => {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `shot-${Math.random()}.jpg`);
  await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } }).jpeg().toFile(filePath);
  return filePath;
};
const status = {
  canonConnected: true, canonModel: "Canon EOS R100", canonSerial: "SN-A",
  low: { connected: true, model: "Canon EOS R100", serial: "SN-B", detail: null } as { connected: boolean; model: string | null; serial: string | null; detail: null } | null,
};
const manager = {
  capture: vi.fn(async (dir: string, camera = "high") => ({ filePath: await jpeg(dir), width: 4, height: 4, source: "canon", camera })),
  captureExact: vi.fn(async (dir: string, camera: string) => ({ filePath: await jpeg(dir), width: 4, height: 4, source: "canon", camera })),
  prefocus: vi.fn(async () => {}),
  getCanonSettings: vi.fn(async (camera = "high") => ({ mode: camera, settings: {}, rejected: [] })),
  setCanonSettings: vi.fn(async (_c: object, camera = "high") => ({ mode: camera, settings: {}, rejected: [] })),
  restartCanonWorkers: vi.fn(),
  getStatus: vi.fn(() => status),
};
const outboxStore = { insertCapture: vi.fn() };
let server: Server;
let base: string;
const req = (p: string, method = "GET", body?: object) =>
  fetch(`${base}${p}`, {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(() => {
  const ctx = {
    configStore: { current: { agent: { allowedOrigins: [], sharedSecret: SECRET }, storage: { dataDir }, event: { id: "evt" } } },
    cameraManager: manager,
    outboxStore,
    eventBus: { emit: vi.fn() },
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { vi.clearAllMocks(); writeCameraSerials(dataDir, {}); });

describe("dual camera routes", () => {
  it("/capture takes the camera from the body, high by default, and records it", async () => {
    let res = await req("/capture", "POST");
    expect(res.status).toBe(201);
    expect((await res.json()).camera).toBe("high");
    res = await req("/capture", "POST", { camera: "low" });
    expect((await res.json()).camera).toBe("low");
    expect(manager.capture).toHaveBeenLastCalledWith(expect.any(String), "low");
    expect(outboxStore.insertCapture).toHaveBeenLastCalledWith(expect.objectContaining({ camera: "low" }));
    expect((await req("/capture", "POST", { camera: "side" })).status).toBe(400);
  });

  it("/camera/prefocus passes the camera", async () => {
    await req("/camera/prefocus", "POST", { camera: "low" });
    expect(manager.prefocus).toHaveBeenCalledWith("low");
  });

  it("settings are per camera, saved per camera", async () => {
    const res = await req("/camera/settings?camera=low", "POST", { iso: 0x60 });
    expect((await res.json()).mode).toBe("low");
    expect(readSavedCameraSettings(dataDir, "low")).toEqual({ iso: 0x60 });
    expect(readSavedCameraSettings(dataDir, "high")).toEqual({});
  });

  it("test shot uses exactly that camera and answers 409 when it's down", async () => {
    let res = await req("/camera/test-shot?camera=low", "POST");
    expect(res.status).toBe(200);
    expect(manager.captureExact).toHaveBeenCalledWith(expect.any(String), "low");
    manager.captureExact.mockRejectedValueOnce(new CameraUnavailableError("The low camera is not connected"));
    res = await req("/camera/test-shot?camera=low", "POST");
    expect(res.status).toBe(409);
  });

  it("GET /cameras lists both slots with the remembered serials", async () => {
    writeCameraSerials(dataDir, { high: "SN-A" });
    expect(await (await req("/cameras")).json()).toEqual({
      slots: {
        high: { connected: true, model: "Canon EOS R100", serial: "SN-A", remembered: "SN-A" },
        low: { connected: true, model: "Canon EOS R100", serial: "SN-B", remembered: null },
      },
    });
  });

  it("remember saves the connected serials; swap exchanges them; both restart the workers", async () => {
    expect((await req("/cameras/remember", "POST")).status).toBe(200);
    expect(readCameraSerials(dataDir)).toEqual({ high: "SN-A", low: "SN-B" });
    expect((await req("/cameras/swap", "POST")).status).toBe(200);
    expect(readCameraSerials(dataDir)).toEqual({ high: "SN-B", low: "SN-A" });
    expect(manager.restartCanonWorkers).toHaveBeenCalledTimes(2);
  });

  it("?camera= other than high or low is a 400 on every per-camera route", async () => {
    for (const [p, method] of [
      ["/liveview?camera=side", "GET"],
      ["/camera/settings?camera=LOW", "GET"],
      ["/camera/settings?camera=", "POST"],
      ["/camera/settings/reset?camera=side", "POST"],
      ["/camera/test-shot?camera=low&camera=high", "POST"],
    ] as const) {
      const res = await req(p, method, method === "POST" ? {} : undefined);
      expect(res.status, p).toBe(400);
      expect((await res.json()).error, p).toBe('camera must be "high" or "low"');
    }
    expect(manager.captureExact).not.toHaveBeenCalled();
    expect(manager.getCanonSettings).not.toHaveBeenCalled();
    expect(manager.setCanonSettings).not.toHaveBeenCalled();
  });

  it("?camera=high is accepted like no camera at all", async () => {
    expect((await req("/camera/settings?camera=high")).status).toBe(200);
    expect(manager.getCanonSettings).toHaveBeenLastCalledWith("high");
  });

  it("remember with no camera connected is a 409", async () => {
    manager.getStatus.mockReturnValueOnce({ ...status, canonSerial: null, low: null } as never);
    expect((await req("/cameras/remember", "POST")).status).toBe(409);
  });
});
