import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * What a guest session looks like: which layout, and how long the kiosk
 * counts down before each shot. Each event carries its own copy in
 * <dataDir>/events.json (the operator panel edits the active event's); a
 * leftover session.json is only read once, to seed events.json on first start.
 */
export const SessionSettingsSchema = z.object({
  templateId: z.string().min(1),
  firstCountdownSeconds: z.number().int().min(1).max(10),
  betweenShotsSeconds: z.number().int().min(1).max(10),
  /** The attract screen shows this event's prints. Some clients don't want guests' photos on show. */
  attractSlideshow: z.boolean().default(true),
});

export type SessionSettings = z.infer<typeof SessionSettingsSchema>;

export const DEFAULT_SESSION: SessionSettings = {
  templateId: "default-4r-grid",
  firstCountdownSeconds: 3,
  betweenShotsSeconds: 3,
  attractSlideshow: true,
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
