import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

const execFile = vi.fn();
vi.mock("../src/util/exec", () => ({ execFile: (...args: unknown[]) => execFile(...args) }));

import { CanonTetheredSource } from "../src/camera/CanonTetheredSource";

const AF_FAILED = "digiCamControl remote command line utility\r\n:;response:error;message:Canon error code: 8D01\r\n";

/** Fakes CameraControlRemoteCmd.exe: remembers the session folder/name and lets each test decide what the shutter commands do. */
function fakeRemoteCmd(shutter: Record<string, "ok" | "af-fail" | "busy">) {
  let folder = "";
  let name = "";
  const commands: string[] = [];
  execFile.mockImplementation(async (_exe: string, args: string[]) => {
    const command = args[1]!;
    commands.push(command);
    if (command.startsWith("set session.folder ")) folder = command.slice("set session.folder ".length);
    else if (command.startsWith("set session.filenametemplate ")) name = command.slice("set session.filenametemplate ".length);
    else if (shutter[command] === "af-fail") return { code: 0, stdout: AF_FAILED, stderr: "" };
    else if (shutter[command] === "busy") return { code: 0, stdout: ":;response:error;message:Device Busy", stderr: "" };
    else if (shutter[command] === "ok") {
      await sharp({ create: { width: 30, height: 20, channels: 3, background: "#888" } })
        .jpeg()
        .toFile(path.join(folder, `${name}.jpg`));
    }
    return { code: 0, stdout: ":;response:null", stderr: "" };
  });
  return commands;
}

function source() {
  return new CanonTetheredSource({
    digiCamControlExePath: "CameraControlRemoteCmd.exe",
    sessionDir: mkdtempSync(path.join(tmpdir(), "canon-session-")),
    digiCamControlHttpHost: "127.0.0.1",
    digiCamControlHttpPort: 5513,
  } as never);
}

describe("Canon capture autofocus fallback", () => {
  beforeEach(() => {
    execFile.mockReset();
  });

  it("retakes the shot without autofocus when autofocus fails (8D01)", async () => {
    const commands = fakeRemoteCmd({ Capture: "af-fail", CaptureNoAf: "ok" });
    const dest = mkdtempSync(path.join(tmpdir(), "canon-dest-"));

    const result = await source().capture(dest);

    expect(commands.filter((c) => !c.startsWith("set "))).toEqual(["Capture", "CaptureNoAf"]);
    expect(result).toMatchObject({ width: 30, height: 20 });
    expect(path.dirname(result.filePath)).toBe(dest);
  });

  it("does not use the no-autofocus shot when autofocus works", async () => {
    const commands = fakeRemoteCmd({ Capture: "ok" });

    await source().capture(mkdtempSync(path.join(tmpdir(), "canon-dest-")));

    expect(commands).not.toContain("CaptureNoAf");
  });

  it("still fails on other camera errors", async () => {
    const commands = fakeRemoteCmd({ Capture: "busy" });

    await expect(source().capture(mkdtempSync(path.join(tmpdir(), "canon-dest-")))).rejects.toThrow("Device Busy");
    expect(commands).not.toContain("CaptureNoAf");
  });
});
