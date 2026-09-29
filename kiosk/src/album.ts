// The event album inside the kiosk: the operator panel's link and QR, and the attract screen's slideshow.
// The slideshow order mirrors download/album-logic.js, which the online album page uses.

/** GET /album-info. `token` is null while the album is off (no album.token in booth.config.json). */
export interface AlbumInfo {
  token: string | null;
  eventId: string;
  eventName: string;
  attractSlideshow: boolean;
}

/**
 * The online album link for the client, on the same site as the guest download page
 * (VITE_DOWNLOAD_URL), keeping its `p` (the event's own Supabase project) if it has one.
 * Null while the album is off or the download page isn't set up.
 */
export function albumLink(downloadUrl: string, info: AlbumInfo): string | null {
  if (!info.token) return null;
  let download: URL;
  try {
    download = new URL(downloadUrl);
  } catch {
    return null;
  }
  const link = new URL("/album.html", download.origin);
  link.searchParams.set("event", info.eventId);
  link.searchParams.set("name", info.eventName);
  link.searchParams.set("album", info.token);
  const p = download.searchParams.get("p");
  if (p) link.searchParams.set("p", p);
  return link.href;
}

/** The ids in `ids` that aren't in `known`, in `ids` order. */
export function newIds(known: string[], ids: string[]): string[] {
  const seen = new Set(known);
  return ids.filter((id) => !seen.has(id));
}

/** Newly arrived prints (`queue`) play first; otherwise it moves on from `current` through `order`, looping. */
export function nextSlide(order: string[], queue: string[], current: string | null): { current: string | null; queue: string[] } {
  if (queue.length > 0) return { current: queue[0]!, queue: queue.slice(1) };
  if (order.length === 0) return { current: null, queue };
  return { current: order[(order.indexOf(current ?? "") + 1) % order.length]!, queue };
}
