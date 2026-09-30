// Plain functions (no React), so the root test run can import them without the kiosk's node_modules.

export interface KioskEvent {
  id: string;
  name: string;
  /** YYYY-MM-DD */
  date: string;
}

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

/** A download link that is set but has no {eventId}: after an event switch its QR codes still name the old event. */
export const namesFixedEvent = (template: string): boolean => !!template && !template.includes("{eventId}");
