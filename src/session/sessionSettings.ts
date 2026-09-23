import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * What a guest session looks like: which layout, and how long the kiosk
 * counts down before each shot. The operator changes these from the kiosk's
 * operator panel during an event, so they live in their own file in the data
 * dir rather than in booth.config.json - the API rewriting that file would
 * clobber comments, formatting and anything an operator was mid-way through
 * editing by hand.
 */
export const SessionSettingsSchema = z.object({
  templateId: z.string().min(1),
  firstCountdownSeconds: z.number().int().min(1).max(10),
  betweenShotsSeconds: z.number().int().min(1).max(10),
});

export type SessionSettings = z.infer<typeof SessionSettingsSchema>;

export const DEFAULT_SESSION: SessionSettings = {
  templateId: "default-4r-grid",
  firstCountdownSeconds: 3,
  betweenShotsSeconds: 3,
};

function settingsPath(dataDir: string): string {
  return path.join(dataDir, "session.json");
}

/** Missing or unreadable file = defaults, so a fresh booth works before anyone opens Settings. */
export function readSessionSettings(dataDir: string): SessionSettings {
  const file = settingsPath(dataDir);
  if (!existsSync(file)) return DEFAULT_SESSION;
  try {
    return SessionSettingsSchema.parse({ ...DEFAULT_SESSION, ...JSON.parse(readFileSync(file, "utf-8")) });
  } catch {
    return DEFAULT_SESSION;
  }
}

export function writeSessionSettings(dataDir: string, settings: SessionSettings): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsPath(dataDir), JSON.stringify(settings, null, 2) + "\n");
}
