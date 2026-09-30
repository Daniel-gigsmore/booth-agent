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

/** Which event is on, and each event's album token (src/session/eventStore.ts). */
export interface AlbumEvents {
  activeId(): string;
  tokenFor(eventId: string): string | undefined;
}

export interface AlbumStatus {
  enabled: boolean;
  photoCount: number | null;
  lastWrittenAt: string | null;
  lastError: string | null;
  /** ISO time of the first failure in the current failing streak; null after a success, and when disabled. */
  failingSince: string | null;
}

/**
 * Keeps each event's `captures/<event>/albums/<token>.json`, the list the album page reads, in step with the
 * prints in Supabase. The sync worker calls markDirty() when a print uploads and publishIfDirty()
 * at the end of every tick. A write that fails stays dirty and is retried. Nothing here throws into
 * the sync worker: an album that can't be written must never hold up photo uploads.
 */
export class AlbumPublisher {
  // Events whose album needs rewriting. The active event is added on the first tick, so a
  // write lost before a restart is caught up.
  private readonly dirty = new Set<string>();
  private activeTarget: string | null = null;
  private retryAt = 0;
  /** photoCount and lastWrittenAt are the active event's; lastError and failingSince cover any event. */
  private written: Omit<AlbumStatus, "enabled"> = { photoCount: null, lastWrittenAt: null, lastError: null, failingSince: null };
  private lastLogged: { message: string; at: number } | null = null;

  constructor(
    private readonly backend: AlbumBackend,
    private readonly events: AlbumEvents,
    private readonly now: () => number = Date.now
  ) {}

  markDirty(eventId: string): void {
    this.dirty.add(eventId);
  }

  async publishIfDirty(): Promise<void> {
    const activeId = this.events.activeId();
    const target = `${activeId}/${this.events.tokenFor(activeId) ?? ""}`;
    if (target !== this.activeTarget) {
      // A newly active event (or a new token) needs its manifest right away, so its link works.
      this.activeTarget = target;
      this.dirty.add(activeId);
      this.retryAt = 0;
    }
    if (this.dirty.size === 0 || this.now() < this.retryAt) return;

    for (const eventId of [...this.dirty]) {
      const token = this.events.tokenFor(eventId);
      // Cleared before the write, so a print that uploads while it runs marks it dirty again.
      this.dirty.delete(eventId);
      if (!token) continue;
      try {
        const photos = await this.backend.listPrints(eventId);
        const at = new Date(this.now()).toISOString();
        await this.backend.writeManifest(eventId, token, { updatedAt: at, photos });
        this.written = {
          ...(eventId === activeId ? { photoCount: photos.length, lastWrittenAt: at } : this.written),
          lastError: null,
          failingSince: null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.dirty.add(eventId);
        this.retryAt = this.now() + ALBUM_RETRY_MS;
        this.written = {
          ...this.written,
          lastError: message,
          failingSince: this.written.failingSince ?? new Date(this.now()).toISOString(),
        };
        this.warnQuietly(`Album manifest for ${eventId} not written, will retry: ${message}`);
        return;
      }

      try {
        await this.backend.removeOtherManifests(eventId, token);
      } catch (err) {
        // Tried again after the next write; a leftover old manifest is not worth re-dirtying for.
        this.warnQuietly(`Could not remove old album manifests: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  getStatus(): AlbumStatus {
    if (!this.events.tokenFor(this.events.activeId())) {
      return { enabled: false, photoCount: null, lastWrittenAt: null, lastError: null, failingSince: null };
    }
    return { enabled: true, ...this.written };
  }

  private warnQuietly(message: string): void {
    const now = this.now();
    if (this.lastLogged?.message === message && now - this.lastLogged.at < REPEAT_QUIET_MS) return;
    this.lastLogged = { message, at: now };
    log.warn(message);
  }
}
