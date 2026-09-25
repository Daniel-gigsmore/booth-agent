import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SettingChanges } from "./edsdk/protocol";

/**
 * The operator's camera settings (raw EDSDK codes), kept next to session.json
 * and re-applied whenever the camera reconnects - so a battery swap or a guest
 * fiddling with the dials doesn't silently change how the photos look.
 */
const code = z.number().int().nonnegative();
export const SettingChangesSchema = z
  .object({ iso: code, av: code, tv: code, wb: code, ev: code, quality: code })
  .partial()
  .strict();

const file = (dataDir: string) => path.join(dataDir, "camera.json");

export function readSavedCameraSettings(dataDir: string): SettingChanges {
  if (!existsSync(file(dataDir))) return {};
  try {
    // zod's `.partial()` types each key as `number | undefined`; exactOptionalPropertyTypes
    // treats that as stricter than "key may be absent", which is all SettingChanges means.
    return SettingChangesSchema.parse(JSON.parse(readFileSync(file(dataDir), "utf-8"))) as SettingChanges;
  } catch {
    return {};
  }
}

/** Merges `changes` into what's saved and returns the result. */
export function saveCameraSettings(dataDir: string, changes: SettingChanges): SettingChanges {
  const merged = { ...readSavedCameraSettings(dataDir), ...changes };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file(dataDir), JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

export function clearSavedCameraSettings(dataDir: string): void {
  rmSync(file(dataDir), { force: true });
}
