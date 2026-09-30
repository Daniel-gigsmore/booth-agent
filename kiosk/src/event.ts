// The active event comes from booth-agent (/health), so switching events never needs a rebuild.
import { createContext, useContext } from "react";

export interface KioskEvent {
  id: string;
  name: string;
  /** YYYY-MM-DD */
  date: string;
}

/** Provided by App from /health; null until the agent first answers. */
export const EventContext = createContext<KioskEvent | null>(null);

export const useEvent = () => useContext(EventContext);

/**
 * The guest download link for one print. VITE_DOWNLOAD_URL may use {eventId} and {eventName}
 * as well as {captureId}; a link that needs the event gives "" (no QR) until the agent answers.
 */
export function fillDownloadUrl(template: string, captureId: string, event: KioskEvent | null): string {
  if (!template) return "";
  if (!event && /\{event(Id|Name)\}/.test(template)) return "";
  return template
    .replace("{captureId}", captureId)
    .replace("{eventId}", encodeURIComponent(event?.id ?? ""))
    .replace("{eventName}", encodeURIComponent(event?.name ?? ""));
}
