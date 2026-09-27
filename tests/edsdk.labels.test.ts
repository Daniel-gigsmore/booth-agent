import { describe, it, expect } from "vitest";
import { aeModeLabel, afModeLabel, batteryLevel, imageQuality, qualityLabel, settingLabel } from "../src/camera/edsdk/cameraLabels";

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

describe("setting labels", () => {
  it("ISO, aperture and shutter from Canon's tables", () => {
    expect(settingLabel("iso", 0)).toBe("ISO Auto");
    expect(settingLabel("iso", 0x58)).toBe("ISO 400");
    expect(settingLabel("iso", 0x70)).toBe("ISO 3200");
    expect(settingLabel("av", 0x30)).toBe("f/5.6");
    expect(settingLabel("av", 0x2d)).toBe("f/5");
    expect(settingLabel("tv", 0x70)).toBe("1/125");
    expect(settingLabel("tv", 0x38)).toBe('1"');
    expect(settingLabel("tv", 0x0c)).toBe("Bulb");
    expect(settingLabel("iso", 0x99)).toBe("0x99");
  });

  it("white balance, including signed codes", () => {
    expect(settingLabel("wb", 0)).toBe("Auto (ambience)");
    expect(settingLabel("wb", 23)).toBe("Auto (white)");
    expect(settingLabel("wb", 1)).toBe("Daylight");
    expect(settingLabel("wb", 0xffffffff)).toBe("0xFFFFFFFF");
  });

  it("exposure compensation in thirds and halves", () => {
    expect(settingLabel("ev", 0)).toBe("0");
    expect(settingLabel("ev", 0x03)).toBe("+1/3");
    expect(settingLabel("ev", 0x0b)).toBe("+1 1/3");
    expect(settingLabel("ev", 0x10)).toBe("+2");
    expect(settingLabel("ev", 0xfb)).toBe("-2/3");
    expect(settingLabel("ev", 0xf8)).toBe("-1");
    expect(settingLabel("ev", 0x04)).toBe("+1/2");
    expect(settingLabel("ev", 0x01)).toBe("0x1");
  });

  it("image quality with size and compression", () => {
    expect(qualityLabel(0x0013ff0f)).toBe("L JPEG Fine");
    expect(qualityLabel(0x0112ff0f)).toBe("M JPEG Normal");
    expect(qualityLabel(0x0064ff0f)).toBe("RAW");
    expect(qualityLabel(0x00640013)).toBe("RAW + L JPEG Fine");
    expect(qualityLabel(0x0083ff0f)).toBe("L HEIF Fine");
    expect(settingLabel("quality", 0x0013ff0f)).toBe("L JPEG Fine");
  });
});
