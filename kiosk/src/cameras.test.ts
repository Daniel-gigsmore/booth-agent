import { describe, expect, it } from "vitest";
import type { CameraPairing, CameraStatus, Health } from "./agent";
import { cameraNote, hasLowSlot, pairingText, slotNote } from "./cameras";

const status = (over: Partial<CameraStatus> = {}): CameraStatus => ({
  connected: true, model: "Canon EOS R100", serial: "378032000939", detail: null, ...over,
});
const health = (low: CameraStatus | null) => ({ cameras: { high: status(), low } }) as unknown as Health;
const slot = (remembered: string | null) => ({ connected: true, model: "Canon EOS R100", serial: "1", remembered });

describe("cameraNote", () => {
  it("says there is no camera", () => {
    expect(cameraNote({ activeSource: "none", model: null })).toBe("No camera");
  });
  it("lists only the parts the agent knows", () => {
    expect(cameraNote({
      activeSource: "canon", model: "R100", battery: 80, mode: "M", afMode: "AI Servo",
      quality: { label: "RAW+JPEG", hasJpeg: true },
    })).toBe("Using canon · 80% · M · AI Servo · RAW+JPEG");
    expect(cameraNote({ activeSource: "canon", model: "R100", battery: "ac" })).toBe("Using canon · AC power");
  });
});

describe("slotNote", () => {
  it("says a slot with no camera is not connected", () => {
    expect(slotNote(status({ connected: false }))).toBe("Not connected");
  });
  it("says Connected when the camera has reported no detail yet", () => {
    expect(slotNote(status())).toBe("Connected");
  });
  it("lists battery, mode, AF and quality", () => {
    expect(slotNote(status({
      detail: { battery: 55, mode: "Av", afMode: "One Shot", quality: { label: "L", hasJpeg: true }, lastError: null },
    }))).toBe("55% · Av · One Shot · L");
  });
});

describe("hasLowSlot", () => {
  it("is false with no health, and under digiCamControl (low is null)", () => {
    expect(hasLowSlot(null)).toBe(false);
    expect(hasLowSlot(health(null))).toBe(false);
  });
  it("is true when the agent has a low slot, even with no camera in it", () => {
    expect(hasLowSlot(health(status({ connected: false })))).toBe(true);
  });
});

describe("pairingText", () => {
  it("says the pairing is remembered when either slot has a saved serial", () => {
    const p: CameraPairing = { high: slot("1"), low: slot(null) };
    expect(pairingText(p)).toMatch(/^Pairing remembered/);
  });
  it("says it is not remembered yet otherwise", () => {
    const p: CameraPairing = { high: slot(null), low: slot(null) };
    expect(pairingText(p)).toMatch(/^Pairing not remembered yet/);
  });
});
