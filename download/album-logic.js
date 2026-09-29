// Pure logic for the album page (album.html + album.js). No DOM here, so vitest can test it.
import { EVENT, UUID, parseProject, projectUrl } from "./photo.js";

export const POLL_MS = 15000;
export const SLIDE_MS = 6000;

const ALBUM = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Online: `?event=<event_id>&album=<token>[&name=][&p=][&play=1]`.
 * Local, served by booth-agent: `?local=1&token=<agent shared secret>[&name=][&play=1]`.
 * Null when anything required is missing or malformed.
 */
export function parseAlbumLink(search) {
  const params = new URLSearchParams(search);
  const name = params.get("name")?.trim() || null;
  const play = params.get("play") === "1";
  if (params.get("local") === "1") {
    const token = params.get("token");
    return token ? { source: "local", token, name, play } : null;
  }
  const event = params.get("event");
  const album = params.get("album");
  if (!event || !EVENT.test(event) || !album || !ALBUM.test(album)) return null;
  const project = parseProject(params);
  if (project === undefined) return null;
  return { source: "online", event, album, name, project, play };
}

/** Where the list of photos is; `now` busts any cached copy. */
export function manifestUrl(link, now) {
  if (link.source === "local") return `/album.json?token=${encodeURIComponent(link.token)}&t=${now}`;
  return `${projectUrl(link)}/storage/v1/object/public/captures/${link.event}/albums/${link.album}.json?t=${now}`;
}

export function photoUrl(link, id) {
  if (link.source === "local") {
    return `/captures/${encodeURIComponent(id)}/image?variant=composite&token=${encodeURIComponent(link.token)}`;
  }
  return `${projectUrl(link)}/storage/v1/object/public/captures/${link.event}/${id}.jpg`;
}

export function albumFileName(link, id) {
  return `kachak-${link.source === "online" ? link.event : "album"}-${id.slice(0, 8)}.jpg`;
}

/** The photo ids in a manifest, in order. Anything malformed is dropped rather than breaking the page. */
export function manifestIds(manifest) {
  if (!manifest || !Array.isArray(manifest.photos)) return [];
  return manifest.photos.map((photo) => photo?.id).filter((id) => typeof id === "string" && UUID.test(id));
}

/** The ids in `ids` that aren't in `known`, in `ids` order. */
export function newIds(known, ids) {
  const seen = new Set(known);
  return ids.filter((id) => !seen.has(id));
}

/**
 * The slideshow's next photo. Photos that arrived while it was playing (`queue`) go first, in arrival
 * order; otherwise it moves on from `current` through `order`, looping, and starts at the top when
 * `current` is null or no longer in the album.
 */
export function nextSlide(order, queue, current) {
  if (queue.length > 0) return { current: queue[0], queue: queue.slice(1) };
  if (order.length === 0) return { current: null, queue };
  return { current: order[(order.indexOf(current) + 1) % order.length], queue };
}
