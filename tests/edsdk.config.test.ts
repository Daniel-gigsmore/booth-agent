import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    writeFileSync(dll, "");
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
});
