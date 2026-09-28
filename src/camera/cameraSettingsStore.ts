import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CameraSlot } from "../events/types";
import { SettingChanges } from "./edsdk/protocol";

/**
 * The operator's camera settings (raw EDSDK codes), kept per camera as camera-high.json / camera-low.json
 * and re-applied whenever the camera reconnects - so a battery swap or a guest
 * fiddling with the dials doesn't silently change how the photos look.
 */
const code = z.number().int().nonnegative();
export const SettingChangesSchema = z
  .object({ iso: code, av: code, tv: code, wb: code, ev: code, quality: code })
  .partial()
  .strict();

const file = (dataDir: string, slot: CameraSlot) => path.join(dataDir, `camera-${slot}.json`);

export function readSavedCameraSettings(dataDir: string, slot: CameraSlot): SettingChanges {
  if (!existsSync(file(dataDir, slot))) return {};
  try {
    // zod's `.partial()` types each key as `number | undefined`; exactOptionalPropertyTypes
    // treats that as stricter than "key may be absent", which is all SettingChanges means.
    return SettingChangesSchema.parse(JSON.parse(readFileSync(file(dataDir, slot), "utf-8"))) as SettingChanges;
  } catch {
    return {};
  }
}

/** Merges `changes` into what's saved for this camera and returns the result. */
export function saveCameraSettings(dataDir: string, slot: CameraSlot, changes: SettingChanges): SettingChanges {
  const merged = { ...readSavedCameraSettings(dataDir, slot), ...changes };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file(dataDir, slot), JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

export function clearSavedCameraSettings(dataDir: string, slot: CameraSlot): void {
  rmSync(file(dataDir, slot), { force: true });
}

/** Before two cameras there was one camera.json; it belongs to the high camera. */
export function migrateLegacyCameraSettings(dataDir: string): void {
  const legacy = path.join(dataDir, "camera.json");
  if (existsSync(legacy) && !existsSync(file(dataDir, "high"))) renameSync(legacy, file(dataDir, "high"));
}
