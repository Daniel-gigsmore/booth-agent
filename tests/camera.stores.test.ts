import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCameraSerials, writeCameraSerials, workerTarget } from "../src/camera/camerasStore";
import {
  readSavedCameraSettings, saveCameraSettings, clearSavedCameraSettings, migrateLegacyCameraSettings,
} from "../src/camera/cameraSettingsStore";

const dir = () => mkdtempSync(path.join(tmpdir(), "camstore-"));

describe("cameras.json", () => {
  it("round-trips serials and treats missing or corrupt files as nothing saved", () => {
    const d = dir();
    expect(readCameraSerials(d)).toEqual({});
    writeCameraSerials(d, { high: "SN-A", low: "SN-B" });
    expect(readCameraSerials(d)).toEqual({ high: "SN-A", low: "SN-B" });
    writeFileSync(path.join(d, "cameras.json"), "{nope");
    expect(readCameraSerials(d)).toEqual({});
  });

  it("tells each slot's worker its body and the other slot's body to avoid", () => {
    expect(workerTarget({ high: "SN-A", low: "SN-B" }, "low")).toEqual({ serial: "SN-B", avoid: "SN-A" });
    expect(workerTarget({ high: "SN-A" }, "low")).toEqual({ serial: null, avoid: "SN-A" });
    expect(workerTarget({}, "high")).toEqual({ serial: null, avoid: null });
  });
});

describe("per-camera settings", () => {
  it("keeps each slot's settings in its own file", () => {
    const d = dir();
    saveCameraSettings(d, "high", { iso: 0x48 });
    saveCameraSettings(d, "low", { iso: 0x60 });
    expect(readSavedCameraSettings(d, "high")).toEqual({ iso: 0x48 });
    expect(readSavedCameraSettings(d, "low")).toEqual({ iso: 0x60 });
    clearSavedCameraSettings(d, "low");
    expect(readSavedCameraSettings(d, "low")).toEqual({});
    expect(readSavedCameraSettings(d, "high")).toEqual({ iso: 0x48 });
  });

  it("moves an old camera.json to camera-high.json once, never over an existing one", () => {
    const d = dir();
    writeFileSync(path.join(d, "camera.json"), JSON.stringify({ iso: 0x48 }));
    migrateLegacyCameraSettings(d);
    expect(existsSync(path.join(d, "camera.json"))).toBe(false);
    expect(readSavedCameraSettings(d, "high")).toEqual({ iso: 0x48 });

    writeFileSync(path.join(d, "camera.json"), JSON.stringify({ iso: 0x60 }));
    migrateLegacyCameraSettings(d);
    expect(JSON.parse(readFileSync(path.join(d, "camera-high.json"), "utf-8"))).toEqual({ iso: 0x48 });
  });
});
