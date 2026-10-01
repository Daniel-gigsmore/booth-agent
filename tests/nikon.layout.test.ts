import { describe, it, expect } from "vitest";
import {
  decodeDevices,
  DEVICE_INFO,
  encodeCallbacks,
  encodeShooting,
  nkError,
  NK,
  SHOOTING,
} from "../src/camera/nikon/nikonLayout";

// Sizes/offsets printed from the SDK's own headers compiled for Win64 (pack(2)).
describe("Nikon SDK layouts", () => {
  it("lays out MAIDShootingStructure as the Windows SDK does", () => {
    const buf = encodeShooting("C:\\BoothAgent\\data\\.nikon-x", true);
    expect(buf.length).toBe(2078);
    expect(buf.readUInt32LE(0)).toBe(NK.SHOOT_SINGLE);
    expect(buf.readUInt8(20)).toBe(1);
    const text = buf.subarray(22, 22 + 2048);
    expect(text.toString("utf16le").replace(/\0+$/, "")).toBe("C:\\BoothAgent\\data\\.nikon-x");
    expect(buf.readBigUInt64LE(SHOOTING.outRef)).toBe(0n);
    expect(encodeShooting("C:\\x", false).readUInt8(20)).toBe(0);
  });

  it("refuses a save path the 1024-character field can't hold", () => {
    expect(() => encodeShooting("C:\\" + "a".repeat(1100), true)).toThrow(/too long/);
  });

  it("reads packed NkMAIDDeviceInfo records", () => {
    const buf = Buffer.alloc(DEVICE_INFO.size * 2);
    const write = (i: number, id: number, name: string, available: boolean) => {
      const base = i * DEVICE_INFO.size;
      buf.writeUInt32LE(id, base);
      buf.write(name, base + 4, "latin1");
      buf.writeUInt8(available ? 1 : 0, base + 68);
      buf.writeUInt32LE(4242, base + 70); // ulConnectedPID, straight after the bool under pack(2)
    };
    write(0, 3, "Z 30", true);
    write(1, 9, "Z 6_3", false);
    expect(decodeDevices(buf, 2)).toEqual([
      { id: 3, name: "Z 30", available: true },
      { id: 9, name: "Z 6_3", available: false },
    ]);
    expect(decodeDevices(buf, 5)).toHaveLength(2);
  });

  it("orders the callback table as NkMAIDCSCallback does", () => {
    const buf = encodeCallbacks({ uiRequest: 1n, event: 2n, progress: 3n, data: 4n, liveView: 5n });
    expect(buf.length).toBe(48);
    expect([0, 8, 16, 24, 32, 40].map((o) => buf.readBigUInt64LE(o))).toEqual([1n, 2n, 3n, 4n, 5n, 0n]);
  });

  it("names result codes", () => {
    expect(nkError(NK.OUT_OF_FOCUS)).toBe("OutOfFocus (137)");
    expect(nkError(-114)).toBe("DeviceNotAvailable (-114)");
    expect(nkError(9999)).toBe("error 9999");
  });
});
