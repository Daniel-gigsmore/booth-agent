// Pure helpers for showing the booth's cameras in the operator panel.
import type { CameraDetail, CameraPairing, CameraSlot, CameraStatus, Health } from "./agent";

export const SLOT_NAME: Record<CameraSlot, string> = { high: "High camera", low: "Low camera" };

function batteryText(b: CameraDetail["battery"] | undefined): string | null {
  return b === "ac" ? "AC power" : typeof b === "number" ? `${b}%` : null;
}

/** "Using canon · 80% · M · AI Servo · RAW+JPEG" - only the parts the agent knows. */
export function cameraNote(c: Health["camera"]): string {
  if (c.activeSource === "none") return "No camera";
  return [`Using ${c.activeSource}`, batteryText(c.battery), c.mode, c.afMode, c.quality?.label].filter(Boolean).join(" · ");
}

/** One slot: "80% · M · One Shot · L", "Connected" before the camera reports, or "Not connected". */
export function slotNote(s: CameraStatus): string {
  if (!s.connected) return "Not connected";
  const d = s.detail;
  return [batteryText(d?.battery), d?.mode, d?.afMode, d?.quality?.label].filter(Boolean).join(" · ") || "Connected";
}

/** Whether the agent has a low camera slot at all (only under the EDSDK driver). */
export const hasLowSlot = (h: Health | null): boolean => !!h?.cameras?.low;

export function pairingText(p: CameraPairing): string {
  return p.high.remembered || p.low.remembered
    ? "Pairing remembered: each camera reopens in its own slot."
    : "Pairing not remembered yet: which camera is High is arbitrary. Check the live views, Swap if needed, then Remember.";
}
