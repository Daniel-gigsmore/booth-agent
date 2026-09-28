import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkPrint } from "../src/startup/preflight";
import { BoothConfig } from "../src/config/schema";

/** A hot folder root with no s4x6 / s6x2_2 yet, and HFP's status file saying `status`. */
function booth(status: string): BoothConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "preflight-"));
  const hotFolderPath = path.join(dir, "Prints");
  mkdirSync(hotFolderPath);
  const printerStatusPath = path.join(dir, "printer_status.txt");
  writeFileSync(printerStatusPath, JSON.stringify([{ Name: "RX1HS-1", Model: "RX1HS", Status: status, MediaRemaining: 500 }]));
  return { printing: { hotFolderPath, printerStatusPath, printerStatusStaleMs: 60_000 } } as unknown as BoothConfig;
}

const levelOf = (checks: { name: string; level: string }[], name: string) => checks.find((c) => c.name === name)?.level;

describe("preflight print checks", () => {
  it("an offline printer with no profile folders fails only the printer; the folders are a warning", async () => {
    const checks = await checkPrint(booth("STATUS_OFFLINE"));
    expect(levelOf(checks, "print.printer")).toBe("fail");
    expect(levelOf(checks, "print.hotFolder.4x6")).toBe("warn");
    expect(levelOf(checks, "print.hotFolder.2x6-strip")).toBe("warn");
  });

  it("an online printer with no profile folders fails them (the rename signal)", async () => {
    const checks = await checkPrint(booth("STATUS_OK"));
    expect(levelOf(checks, "print.printer")).toBe("ok");
    expect(levelOf(checks, "print.hotFolder.4x6")).toBe("fail");
    expect(levelOf(checks, "print.hotFolder.2x6-strip")).toBe("fail");
  });
});
