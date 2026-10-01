import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Nikon's Remote SDK reads three profiles from
 * %LOCALAPPDATA%\Nikon\NXTether (Remote SDK ReadMe, "Usage notes"). They ship
 * next to ControlServiceLayer.dll.
 *
 * The agent runs as a Windows service under LocalSystem, whose LOCALAPPDATA is
 * C:\Windows\System32\config\systemprofile\AppData\Local - not the folder a
 * person would copy them into by hand. So the worker puts them in place
 * itself, for whichever account it is actually running as.
 */
export const NXTETHER_CONFIG_FILES = ["DC_PTP_Config.config", "MaidLayer.config", "RangeValue.config"] as const;

export function nxTetherDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env["LOCALAPPDATA"];
  return base ? path.join(base, "Nikon", "NXTether") : null;
}

/** Copies any profile that is missing or different. Returns what it copied and what sdkDir lacked. */
export function installNxTetherConfig(sdkDir: string, targetDir: string): { copied: string[]; missing: string[] } {
  const copied: string[] = [];
  const missing: string[] = [];
  for (const name of NXTETHER_CONFIG_FILES) {
    const from = path.join(sdkDir, name);
    if (!existsSync(from)) {
      missing.push(name);
      continue;
    }
    const to = path.join(targetDir, name);
    if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) continue;
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(from, to);
    copied.push(name);
  }
  return { copied, missing };
}
