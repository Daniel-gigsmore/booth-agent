// Pure logic for the guest download page (index.html + main.js). No DOM here, so vitest can test it.

// The default project. An event with its own Supabase project passes `p=<project ref>`
// in the link instead (see download/README.md).
export const SUPABASE_URL = "https://pbtnvpykoueiizsvjwlo.supabase.co";
export const RETRY_MS = 5000;
export const LATER_AFTER_MS = 120000;

export const EVENT = /^[A-Za-z0-9_-]+$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[a-z0-9]{20}$/;

/** `?event=<event_id>&name=<display name>&id=<captureId>[&p=<project ref>]`; null when anything is missing or malformed. */
export function parseLink(search) {
  const params = new URLSearchParams(search);
  const event = params.get("event");
  const id = params.get("id");
  if (!event || !EVENT.test(event) || !id || !UUID.test(id)) return null;
  const project = parseProject(params);
  if (project === undefined) return null;
  const name = params.get("name")?.trim();
  return { event, id, name: name || null, project };
}

/** `p`, the Supabase project ref of an event with its own project: null when absent, undefined when malformed. */
export function parseProject(params) {
  const p = params.get("p");
  if (p === null) return null;
  return PROJECT.test(p) ? p : undefined;
}

/** The link's Supabase project: `p` when given, else SUPABASE_URL. */
export function projectUrl(link) {
  return link.project ? `https://${link.project}.supabase.co` : SUPABASE_URL;
}

/** The composite's public URL; `now` busts any cached 404 or stale image. */
export function imageUrl(link, now) {
  return `${projectUrl(link)}/storage/v1/object/public/captures/${link.event}/${link.id}.jpg?t=${now}`;
}

/** What to show after a failed attempt, by time since the page opened. */
export function waitingState(elapsedMs) {
  return elapsedMs < LATER_AFTER_MS ? "uploading" : "later";
}

export function shareFileName(link) {
  return `kachak-${link.event}-${link.id.slice(0, 8)}.jpg`;
}
