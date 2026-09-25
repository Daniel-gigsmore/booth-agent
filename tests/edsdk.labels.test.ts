import { describe, it, expect } from "vitest";
import { aeModeLabel, afModeLabel, batteryLevel, imageQuality } from "../src/camera/edsdk/cameraLabels";

describe("camera labels", () => {
  it("battery: AC, percent, or unknown", () => {
    expect(batteryLevel(0xffffffff)).toBe("ac");
    expect(batteryLevel(80)).toBe(80);
    expect(batteryLevel(0)).toBe(0);
    expect(batteryLevel(101)).toBeNull();
  });

  it("mode dial and AF mode, with hex for the unknown", () => {
    expect(aeModeLabel(3)).toBe("M");
    expect(aeModeLabel(2)).toBe("Av");
    expect(aeModeLabel(22)).toBe("Scene Intelligent Auto");
    expect(aeModeLabel(0x33)).toBe("0x33");
    expect(afModeLabel(1)).toBe("AI Servo");
    expect(afModeLabel(3)).toBe("Manual");
    expect(afModeLabel(7)).toBe("0x7");
  });

  it("image quality: formats and whether a JPEG comes out", () => {
    expect(imageQuality(0x0013ff0f)).toEqual({ label: "JPEG", hasJpeg: true }); // L JPEG Fine
    expect(imageQuality(0x0064ff0f)).toEqual({ label: "RAW", hasJpeg: false }); // RAW only
    expect(imageQuality(0x00640013)).toEqual({ label: "RAW+JPEG", hasJpeg: true }); // RAW + L JPEG Fine
    expect(imageQuality(0x0083ff0f)).toEqual({ label: "HEIF", hasJpeg: false });
    expect(imageQuality(0x00f3ff0f)).toEqual({ label: "0xF", hasJpeg: false });
  });
});
