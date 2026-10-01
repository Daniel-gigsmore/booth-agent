import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoothConfig, BoothConfigSchema, CanonConfigSchema, NikonConfigSchema } from "../src/config/schema";
import { buildCameraSlots, CameraFactories } from "../src/camera/cameraSlots";
import { CameraSource } from "../src/camera/CameraSource";
import { checkNikon } from "../src/startup/preflight";
import { installNxTetherConfig, NXTETHER_CONFIG_FILES, nxTetherDir } from "../src/camera/nikon/nxTetherConfig";

const canon = (driver: "edsdk" | "digicamcontrol") =>
  CanonConfigSchema.parse({ driver, digiCamControlExePath: "C:\\x\\Cmd.exe", sessionDir: "C:\\x\\s" });

function capture(driver: "edsdk" | "digicamcontrol", nikon: Partial<{ enabled: boolean; slot: "high" | "low" }> = {}) {
  return { sourcePreference: "canon", canon: canon(driver), nikon: NikonConfigSchema.parse(nikon) } as unknown as BoothConfig["capture"];
}

/** Factories that return labelled stand-ins, recording how each Canon worker was asked for. */
function factories() {
  const made: string[] = [];
  const source = (name: string) => ({ name }) as unknown as CameraSource;
  const make: CameraFactories = {
    edsdk: (slot, alone) => {
      made.push(`edsdk:${slot}${alone ? ":alone" : ""}`);
      return source(`edsdk:${slot}`);
    },
    digiCamControl: () => source("dcc"),
    nikon: () => source("nikon"),
  };
  return { make, made };
}
const names = (slots: { high: CameraSource; low?: CameraSource }) => ({
  high: (slots.high as unknown as { name: string }).name,
  low: (slots.low as unknown as { name: string } | undefined)?.name,
});

describe("Nikon config", () => {
  it("is off by default, in the low slot, from C:\\BoothAgent\\nikon", () => {
    expect(NikonConfigSchema.parse(undefined)).toEqual({ enabled: false, slot: "low", sdkDir: "C:\\BoothAgent\\nikon" });
  });

  it("parses inside the example config", () => {
    const example = JSON.parse(readFileSync(path.join(__dirname, "..", "booth.config.example.json"), "utf8"));
    expect(BoothConfigSchema.parse(example).capture.nikon.enabled).toBe(false);
  });
});

describe("camera slots", () => {
  it("are unchanged without a Nikon", () => {
    const { make, made } = factories();
    expect(names(buildCameraSlots(capture("edsdk"), make))).toEqual({ high: "edsdk:high", low: "edsdk:low" });
    expect(made).toEqual(["edsdk:high", "edsdk:low"]);
    expect(names(buildCameraSlots(capture("digicamcontrol"), make))).toEqual({ high: "dcc", low: undefined });
  });

  it("put the Nikon low and the only Canon high", () => {
    const { make, made } = factories();
    expect(names(buildCameraSlots(capture("edsdk", { enabled: true, slot: "low" }), make))).toEqual({ high: "edsdk:high", low: "nikon" });
    expect(made).toEqual(["edsdk:high:alone"]);
  });

  it("put the Nikon high and the Canon low", () => {
    const { make, made } = factories();
    expect(names(buildCameraSlots(capture("edsdk", { enabled: true, slot: "high" }), make))).toEqual({ high: "nikon", low: "edsdk:low" });
    expect(made).toEqual(["edsdk:low:alone"]);
    expect(names(buildCameraSlots(capture("digicamcontrol", { enabled: true, slot: "high" }), make))).toEqual({ high: "nikon", low: "dcc" });
  });
});

describe("NXTether profiles", () => {
  const sdk = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nikon-sdk-"));
    for (const name of NXTETHER_CONFIG_FILES) writeFileSync(path.join(dir, name), `profile ${name}`);
    return dir;
  };

  it("live under LOCALAPPDATA\\Nikon\\NXTether", () => {
    expect(nxTetherDir({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })).toBe(path.join("C:\\Users\\x\\AppData\\Local", "Nikon", "NXTether"));
    expect(nxTetherDir({})).toBeNull();
  });

  it("are copied when missing, left alone when identical, refreshed when different", () => {
    const from = sdk();
    const to = path.join(mkdtempSync(path.join(tmpdir(), "nxtether-")), "Nikon", "NXTether");
    expect(installNxTetherConfig(from, to)).toEqual({ copied: [...NXTETHER_CONFIG_FILES], missing: [] });
    expect(readFileSync(path.join(to, "MaidLayer.config"), "utf8")).toBe("profile MaidLayer.config");
    expect(installNxTetherConfig(from, to).copied).toEqual([]);
    writeFileSync(path.join(to, "RangeValue.config"), "stale");
    expect(installNxTetherConfig(from, to).copied).toEqual(["RangeValue.config"]);
  });

  it("reports profiles the SDK folder lacks", () => {
    const from = mkdtempSync(path.join(tmpdir(), "nikon-sdk-empty-"));
    const to = path.join(from, "out");
    expect(installNxTetherConfig(from, to)).toEqual({ copied: [], missing: [...NXTETHER_CONFIG_FILES] });
    expect(existsSync(to)).toBe(false);
  });
});

describe("Nikon preflight", () => {
  const config = (sdkDir: string, slot: "high" | "low" = "low") =>
    ({ capture: { sourcePreference: "canon", nikon: NikonConfigSchema.parse({ enabled: true, slot, sdkDir }) } }) as unknown as BoothConfig;
  const pe = (file: string, machine: number) => {
    const buf = Buffer.alloc(0x100);
    buf.writeUInt32LE(0x80, 0x3c);
    buf.write("PE\0\0", 0x80, "latin1");
    buf.writeUInt16LE(machine, 0x84);
    writeFileSync(file, buf);
  };
  const byName = (checks: Array<{ name: string; level: string }>) => Object.fromEntries(checks.map((c) => [c.name, c.level]));

  it("checks nothing while the Nikon is off", async () => {
    expect(await checkNikon({ capture: { nikon: NikonConfigSchema.parse({}) } } as unknown as BoothConfig)).toEqual([]);
  });

  it("passes with a 64-bit SDK and its profiles", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nikon-pre-"));
    pe(path.join(dir, "ControlServiceLayer.dll"), 0x8664);
    for (const name of NXTETHER_CONFIG_FILES) writeFileSync(path.join(dir, name), "x");
    const levels = byName(await checkNikon(config(dir), dir));
    expect(levels["nikon.sdk"]).toBe("ok");
    expect(levels["nikon.profiles"]).toBe("ok");
  });

  it("warns for a missing SDK in the low slot and fails in the high one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nikon-pre-empty-"));
    expect(byName(await checkNikon(config(dir, "low"), dir))["nikon.sdk"]).toBe("warn");
    expect(byName(await checkNikon(config(dir, "high"), dir))["nikon.sdk"]).toBe("fail");
    expect(byName(await checkNikon(config(dir, "low"), dir))["nikon.profiles"]).toBe("warn");
  });

  it("rejects a 32-bit SDK", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nikon-pre-32-"));
    pe(path.join(dir, "ControlServiceLayer.dll"), 0x14c);
    const sdk = (await checkNikon(config(dir), dir)).find((c) => c.name === "nikon.sdk")!;
    expect(sdk.level).toBe("warn");
    expect(sdk.message).toMatch(/ControlServiceLayer\.dll .* is not 64-bit/);
  });
});
