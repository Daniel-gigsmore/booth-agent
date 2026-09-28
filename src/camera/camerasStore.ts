import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CameraSlot } from "../events/types";
import type { CameraTarget } from "./edsdk/CameraWorker";

/**
 * Which camera body (by serial) is the high one and which the low one, as the
 * operator confirmed it in the Camera tab. Without it the two workers each take
 * whichever free body they open first, so the pairing is arbitrary.
 */
export type CameraSerials = Partial<Record<CameraSlot, string>>;

const Schema = z.object({ high: z.string().min(1), low: z.string().min(1) }).partial().strict();
const file = (dataDir: string) => path.join(dataDir, "cameras.json");

export function readCameraSerials(dataDir: string): CameraSerials {
  if (!existsSync(file(dataDir))) return {};
  try {
    return Schema.parse(JSON.parse(readFileSync(file(dataDir), "utf-8"))) as CameraSerials;
  } catch {
    return {};
  }
}

export function writeCameraSerials(dataDir: string, serials: CameraSerials): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file(dataDir), JSON.stringify(serials, null, 2) + "\n");
}

/** What a slot's worker is told: the body it owns (null = first free one) and the other slot's body. */
export function workerTarget(serials: CameraSerials, slot: CameraSlot): CameraTarget {
  const other: CameraSlot = slot === "high" ? "low" : "high";
  return { serial: serials[slot] ?? null, avoid: serials[other] ?? null };
}
