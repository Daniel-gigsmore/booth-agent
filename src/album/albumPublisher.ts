import { createLogger } from "../util/logger";

const log = createLogger("album");

/** A failed write is retried no sooner than this, so an offline booth isn't calling Supabase every tick. */
export const ALBUM_RETRY_MS = 15_000;
/** The same failure is logged at most this often. */
const REPEAT_QUIET_MS = 60_000;

export interface AlbumPhoto {
  id: string;
  takenAt: string;
}

export interface AlbumManifest {
  updatedAt: string;
  photos: AlbumPhoto[];
}

/** Where the manifest lives. The real one is Supabase (src/supabase/albumStorage.ts); tests use a fake. */
export interface AlbumBackend {
  /** This event's prints, oldest first. */
  listPrints(eventId: string): Promise<AlbumPhoto[]>;
  writeManifest(eventId: string, token: string, manifest: AlbumManifest): Promise<void>;
  /** Removes every manifest in the event's albums/ folder except `<keepToken>.json`. */
  removeOtherManifests(eventId: string, keepToken: string): Promise<void>;
}

export interface AlbumTarget {
  eventId: string;
  token: string | undefined;
}

export interface AlbumStatus {
  enabled: boolean;
  photoCount: number | null;
  lastWrittenAt: string | null;
  lastError: string | null;
}

/**
 * Keeps `captures/<event>/albums/<token>.json`, the list the album page reads, in step with the
 * prints in Supabase. The sync worker calls markDirty() when a print uploads and publishIfDirty()
 * at the end of every tick. A write that fails stays dirty and is retried. Nothing here throws into
 * the sync worker: an album that can't be written must never hold up photo uploads.
 */
export class AlbumPublisher {
  // Dirty from the start, so a write lost before a restart is caught up.
  private dirty = true;
  private target: string | null = null;
  private retryAt = 0;
  private written: Omit<AlbumStatus, "enabled"> = { photoCount: null, lastWrittenAt: null, lastError: null };
  private lastLogged: { message: string; at: number } | null = null;

  constructor(
    private readonly backend: AlbumBackend,
    private readonly getTarget: () => AlbumTarget,
    private readonly now: () => number = Date.now
  ) {}

  markDirty(): void {
    this.dirty = true;
  }

  async publishIfDirty(): Promise<void> {
    const { eventId, token } = this.getTarget();
    if (!token) return;
    const target = `${eventId}/${token}`;
    if (target !== this.target) {
      // A new token (or event) needs its own manifest right away, and the old one removed.
      this.target = target;
      this.dirty = true;
      this.retryAt = 0;
    }
    if (!this.dirty || this.now() < this.retryAt) return;

    // Cleared before the write, so a print that uploads while it runs marks it dirty again.
    this.dirty = false;
    try {
      const photos = await this.backend.listPrints(eventId);
      const at = new Date(this.now()).toISOString();
      await this.backend.writeManifest(eventId, token, { updatedAt: at, photos });
      this.written = { photoCount: photos.length, lastWrittenAt: at, lastError: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dirty = true;
      this.retryAt = this.now() + ALBUM_RETRY_MS;
      this.written = { ...this.written, lastError: message };
      this.warnQuietly(`Album manifest not written, will retry: ${message}`);
      return;
    }

    try {
      await this.backend.removeOtherManifests(eventId, token);
    } catch (err) {
      // Tried again after the next write; a leftover old manifest is not worth re-dirtying for.
      this.warnQuietly(`Could not remove old album manifests: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getStatus(): AlbumStatus {
    if (!this.getTarget().token) return { enabled: false, photoCount: null, lastWrittenAt: null, lastError: null };
    return { enabled: true, ...this.written };
  }

  private warnQuietly(message: string): void {
    const now = this.now();
    if (this.lastLogged?.message === message && now - this.lastLogged.at < REPEAT_QUIET_MS) return;
    this.lastLogged = { message, at: now };
    log.warn(message);
  }
}
