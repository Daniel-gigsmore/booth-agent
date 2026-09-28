import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import sharp from "sharp";
import { CameraUnavailableError } from "../src/camera/CameraSource";
import { readSavedCameraSettings, saveCameraSettings, clearSavedCameraSettings } from "../src/camera/cameraSettingsStore";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";
import { CameraManager } from "../src/camera/CameraManager";
import { EventBus } from "../src/events/eventBus";
import { CameraSource } from "../src/camera/CameraSource";

describe("camera settings store", () => {
  it("merges, reads back and clears", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "camset-"));
    expect(readSavedCameraSettings(dir, "high")).toEqual({});
    saveCameraSettings(dir, "high", { iso: 0x58 });
    expect(saveCameraSettings(dir, "high", { av: 0x30 })).toEqual({ iso: 0x58, av: 0x30 });
    expect(readSavedCameraSettings(dir, "high")).toEqual({ iso: 0x58, av: 0x30 });
    clearSavedCameraSettings(dir, "high");
    expect(readSavedCameraSettings(dir, "high")).toEqual({});
  });

  it("treats a corrupt file as nothing saved", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "camset-"));
    writeFileSync(path.join(dir, "camera-high.json"), "{nope");
    expect(readSavedCameraSettings(dir, "high")).toEqual({});
  });
});

describe("camera settings routes", () => {
  const SECRET = "test-secret";
  const dataDir = mkdtempSync(path.join(tmpdir(), "camroutes-"));
  const result = { mode: "M", settings: {}, rejected: [] as string[] };
  const manager = {
    getCanonSettings: vi.fn(async () => result),
    setCanonSettings: vi.fn(async () => result),
    capture: vi.fn(async (dir: string) => {
      mkdirSync(dir, { recursive: true }); // real sources create destDir themselves
      const filePath = path.join(dir, "shot.jpg");
      await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } }).jpeg().toFile(filePath);
      return { filePath, width: 4, height: 4, source: "canon" };
    }),
  };
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
      configStore: { current: { agent: { allowedOrigins: [], sharedSecret: SECRET }, storage: { dataDir } } },
      cameraManager: manager,
    } as unknown as AgentContext;
    server = buildHttpApp(ctx).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });
  beforeEach(() => {
    clearSavedCameraSettings(dataDir, "high");
    result.rejected = [];
  });

  it("GET returns the camera's settings plus what is saved", async () => {
    saveCameraSettings(dataDir, "high", { iso: 0x48 });
    const res = await req("/camera/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...result, saved: { iso: 0x48 } });
  });

  it("POST applies, saves only what the camera accepted, and validates the body", async () => {
    result.rejected = ["tv"];
    const res = await req("/camera/settings", "POST", { iso: 0x60, tv: 0x78 });
    expect(res.status).toBe(200);
    expect(manager.setCanonSettings).toHaveBeenCalledWith({ iso: 0x60, tv: 0x78 });
    expect((await res.json()).saved).toEqual({ iso: 0x60 });
    expect(readSavedCameraSettings(dataDir, "high")).toEqual({ iso: 0x60 });
    expect((await req("/camera/settings", "POST", { iso: "high" })).status).toBe(400);
    expect((await req("/camera/settings", "POST", { shutter: 5 })).status).toBe(400);
  });

  it("answers 409 when the camera can't do settings", async () => {
    manager.getCanonSettings.mockRejectedValueOnce(new CameraUnavailableError("Camera settings need the EDSDK driver"));
    const res = await req("/camera/settings");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/EDSDK/);
  });

  it("reset clears the saved settings", async () => {
    saveCameraSettings(dataDir, "high", { iso: 0x48 });
    const res = await req("/camera/settings/reset", "POST");
    expect(await res.json()).toEqual({ saved: {} });
    expect(readSavedCameraSettings(dataDir, "high")).toEqual({});
  });

  it("test shot returns the JPEG and leaves nothing behind", async () => {
    const res = await req("/camera/test-shot", "POST");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/image\/jpeg/);
    expect(res.headers.get("x-capture-source")).toBe("canon");
    expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width).toBe(4);
    const [dir] = manager.capture.mock.calls.at(-1)!;
    expect(existsSync(path.join(dir, "shot.jpg"))).toBe(false);
  });
});

describe("CameraManager canon settings", () => {
  const base = (kind: "canon" | "webcam"): CameraSource => ({
    kind, initialize: async () => true, shutdown: async () => {}, isHealthy: async () => true,
    capture: async () => ({ filePath: "x", width: 1, height: 1 }), getLiveviewFrame: async () => null, getModel: () => kind,
  });

  it("throws CameraUnavailableError when the Canon source can't do settings", async () => {
    const m = new CameraManager({ canon: base("canon"), webcam: base("webcam") }, "canon", new EventBus(), 60_000);
    await expect(m.getCanonSettings()).rejects.toBeInstanceOf(CameraUnavailableError);
    await expect(m.setCanonSettings({ iso: 1 })).rejects.toBeInstanceOf(CameraUnavailableError);
  });

  it("forwards to a source that can", async () => {
    const getSettings = vi.fn(async () => ({ mode: "M", settings: {} as never, rejected: [] }));
    const m = new CameraManager({ canon: { ...base("canon"), getSettings }, webcam: base("webcam") }, "canon", new EventBus(), 60_000);
    await expect(m.getCanonSettings()).resolves.toMatchObject({ mode: "M" });
  });
});
