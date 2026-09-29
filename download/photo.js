// Pure logic for the guest download page (index.html + main.js). No DOM here, so vitest can test it.

export const SUPABASE_URL = "https://pbtnvpykoueiizsvjwlo.supabase.co";
export const RETRY_MS = 5000;
export const LATER_AFTER_MS = 120000;

const EVENT = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?event=<event_id>&name=<display name>&id=<captureId>`; null when event or id is missing or malformed. */
export function parseLink(search) {
  const params = new URLSearchParams(search);
  const event = params.get("event");
  const id = params.get("id");
  if (!event || !EVENT.test(event) || !id || !UUID.test(id)) return null;
  const name = params.get("name")?.trim();
  return { event, id, name: name || null };
}

/** The composite's public URL; `now` busts any cached 404 or stale image. */
export function imageUrl(link, now) {
  return `${SUPABASE_URL}/storage/v1/object/public/captures/${link.event}/${link.id}.jpg?t=${now}`;
}

/** What to show after a failed attempt, by time since the page opened. */
export function waitingState(elapsedMs) {
  return elapsedMs < LATER_AFTER_MS ? "uploading" : "later";
}

export function shareFileName(link) {
  return `kachak-${link.event}-${link.id.slice(0, 8)}.jpg`;
}
