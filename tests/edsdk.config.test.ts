import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A minimal fake PE file: e_lfanew at 0x3C points at 0x80, "PE\0\0" there, machine 4 bytes later. */
function writeFakePe(filePath: string, machine: number): void {
  const buf = Buffer.alloc(0x100);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write("PE\0\0", 0x80, "latin1");
  buf.writeUInt16LE(machine, 0x84);
  writeFileSync(filePath, buf);
}

const running = vi.fn<() => Promise<boolean>>();
vi.mock("../src/camera/CanonTetheredSource", () => ({
  APP_LOG_PATH: "C:\\nowhere\\app.log",
  isDigiCamControlRunning: () => running(),
}));

import { CanonConfigSchema, BoothConfig } from "../src/config/schema";
import { checkCanon } from "../src/startup/preflight";

const baseCanon = {
  digiCamControlExePath: "C:\\x\\CameraControlRemoteCmd.exe",
  sessionDir: "C:\\x\\session",
};

describe("Canon config", () => {
  it("defaults to the digiCamControl driver and the standard EDSDK path", () => {
    const parsed = CanonConfigSchema.parse(baseCanon);
    expect(parsed.driver).toBe("digicamcontrol");
    expect(parsed.edsdkDllPath).toBe("C:\\BoothAgent\\edsdk\\EDSDK.dll");
  });

  it("accepts the edsdk driver", () => {
    expect(CanonConfigSchema.parse({ ...baseCanon, driver: "edsdk" }).driver).toBe("edsdk");
  });
});

describe("preflight with the EDSDK driver", () => {
  let dll: string;
  const config = (edsdkDllPath: string) =>
    ({
      capture: {
        sourcePreference: "canon",
        canon: CanonConfigSchema.parse({ ...baseCanon, driver: "edsdk", edsdkDllPath }),
      },
    }) as unknown as BoothConfig;

  beforeEach(() => {
    dll = path.join(mkdtempSync(path.join(tmpdir(), "edsdk-dll-")), "EDSDK.dll");
    running.mockReset();
  });

  it("passes when the DLL exists and digiCamControl is not running", async () => {
    writeFakePe(dll, 0x8664);
    running.mockResolvedValue(false);
    const checks = await checkCanon(config(dll));
    expect(checks.map((c) => [c.name, c.level])).toEqual([
      ["canon.edsdkDll", "ok"],
      ["canon.digiCamControlConflict", "ok"],
    ]);
  });

  it("fails when the DLL is missing and warns when digiCamControl would fight for the camera", async () => {
    running.mockResolvedValue(true);
    const checks = await checkCanon(config(dll));
    expect(checks.find((c) => c.name === "canon.edsdkDll")?.level).toBe("fail");
    expect(checks.find((c) => c.name === "canon.digiCamControlConflict")?.level).toBe("warn");
  });

  it("fails when the DLL is 32-bit", async () => {
    writeFakePe(dll, 0x14c);
    running.mockResolvedValue(false);
    const checks = await checkCanon(config(dll));
    expect(checks.find((c) => c.name === "canon.edsdkDll")?.level).toBe("fail");
  });
});
