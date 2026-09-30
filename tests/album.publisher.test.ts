import { describe, it, expect } from "vitest";
import { ALBUM_RETRY_MS, AlbumBackend, AlbumManifest, AlbumPhoto, AlbumPublisher } from "../src/album/albumPublisher";
import { BoothConfigSchema } from "../src/config/schema";

class FakeBackend implements AlbumBackend {
  prints: AlbumPhoto[] = [];
  listed: string[] = [];
  written: Array<{ eventId: string; token: string; manifest: AlbumManifest }> = [];
  cleaned: Array<{ eventId: string; keepToken: string }> = [];
  failWrites = 0;
  failCleanup = false;
  onList: (() => void) | null = null;

  async listPrints(eventId: string): Promise<AlbumPhoto[]> {
    this.listed.push(eventId);
    this.onList?.();
    return this.prints;
  }
  async writeManifest(eventId: string, token: string, manifest: AlbumManifest): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error("offline");
    }
    this.written.push({ eventId, token, manifest });
  }
  async removeOtherManifests(eventId: string, keepToken: string): Promise<void> {
    if (this.failCleanup) throw new Error("list failed");
    this.cleaned.push({ eventId, keepToken });
  }
}

const TOKEN = "tok-0123456789abcdef";

function setup(options: { token?: string } = { token: TOKEN }) {
  const backend = new FakeBackend();
  let now = 1_000_000;
  const tokens: Record<string, string | undefined> = { evt: options.token };
  const state = { activeId: "evt" };
  const publisher = new AlbumPublisher(
    backend,
    { activeId: () => state.activeId, tokenFor: (id) => tokens[id] },
    () => now
  );
  return { backend, publisher, tokens, state, advance: (ms: number) => { now += ms; } };
}

describe("AlbumPublisher", () => {
  it("writes once at startup, then only when marked dirty", async () => {
    const { backend, publisher } = setup();
    await publisher.publishIfDirty();
    await publisher.publishIfDirty();
    expect(backend.written).toHaveLength(1);
    publisher.markDirty("evt");
    await publisher.publishIfDirty();
    expect(backend.written).toHaveLength(2);
  });

  it("writes this event's prints, stamped with the time, and reports it", async () => {
    const { backend, publisher } = setup();
    backend.prints = [{ id: "a", takenAt: "2026-09-29T10:00:00.000Z" }];
    await publisher.publishIfDirty();
    const at = new Date(1_000_000).toISOString();
    expect(backend.listed).toEqual(["evt"]);
    expect(backend.written[0]).toEqual({ eventId: "evt", token: TOKEN, manifest: { updatedAt: at, photos: backend.prints } });
    expect(publisher.getStatus()).toEqual({ enabled: true, photoCount: 1, lastWrittenAt: at, lastError: null, failingSince: null });
  });

  it("retries a failed write, but no sooner than ALBUM_RETRY_MS", async () => {
    const { backend, publisher, advance } = setup();
    backend.failWrites = 1;
    await publisher.publishIfDirty();
    expect(publisher.getStatus().lastError).toBe("offline");
    await publisher.publishIfDirty();
    expect(backend.listed).toHaveLength(1);
    advance(ALBUM_RETRY_MS);
    await publisher.publishIfDirty();
    expect(backend.written).toHaveLength(1);
    expect(publisher.getStatus().lastError).toBeNull();
  });

  it("sets failingSince on the first failure of a streak, leaves it on the second, clears it on success", async () => {
    const { backend, publisher, advance } = setup();
    backend.failWrites = 2;
    await publisher.publishIfDirty();
    const firstFailingSince = publisher.getStatus().failingSince;
    expect(firstFailingSince).not.toBeNull();

    advance(ALBUM_RETRY_MS);
    await publisher.publishIfDirty();
    expect(publisher.getStatus().failingSince).toBe(firstFailingSince);

    advance(ALBUM_RETRY_MS);
    await publisher.publishIfDirty();
    expect(publisher.getStatus().failingSince).toBeNull();
  });

  it("removes other manifests after a write; a failed cleanup doesn't undo the write", async () => {
    const { backend, publisher } = setup();
    await publisher.publishIfDirty();
    expect(backend.cleaned).toEqual([{ eventId: "evt", keepToken: TOKEN }]);

    const other = setup();
    other.backend.failCleanup = true;
    await other.publisher.publishIfDirty();
    await other.publisher.publishIfDirty();
    expect(other.backend.written).toHaveLength(1);
    expect(other.publisher.getStatus().lastError).toBeNull();
  });

  it("keeps a print that lands during a write for the next pass", async () => {
    const { backend, publisher } = setup();
    backend.onList = () => {
      backend.onList = null;
      publisher.markDirty("evt");
    };
    await publisher.publishIfDirty();
    await publisher.publishIfDirty();
    expect(backend.written).toHaveLength(2);
  });

  it("rewrites when the token changes", async () => {
    const { backend, publisher, tokens } = setup();
    await publisher.publishIfDirty();
    tokens.evt = "new-0123456789abcdef";
    await publisher.publishIfDirty();
    expect(backend.written.map((w) => w.token)).toEqual([TOKEN, "new-0123456789abcdef"]);
  });

  it("writes each dirty event's album with that event's own token", async () => {
    const { backend, publisher, tokens, state } = setup();
    await publisher.publishIfDirty();
    tokens["new"] = "tok-new-0123456789abcd";
    state.activeId = "new";
    publisher.markDirty("evt"); // a print from the old event finished uploading after the switch
    await publisher.publishIfDirty();
    expect(backend.written.map((w) => `${w.eventId}/${w.token}`)).toEqual([
      `evt/${TOKEN}`,
      `evt/${TOKEN}`,
      "new/tok-new-0123456789abcd",
    ]);
  });

  it("writes a newly active event's album straight away, even with no prints", async () => {
    const { backend, publisher, tokens, state } = setup();
    await publisher.publishIfDirty();
    tokens["new"] = "tok-new-0123456789abcd";
    state.activeId = "new";
    await publisher.publishIfDirty();
    expect(backend.written.at(-1)).toMatchObject({ eventId: "new", token: "tok-new-0123456789abcd" });
  });

  it("skips a dirty event that has no token", async () => {
    const { backend, publisher } = setup();
    await publisher.publishIfDirty();
    publisher.markDirty("tokenless");
    await publisher.publishIfDirty();
    expect(backend.written).toHaveLength(1);
  });

  it("reports the active event's photo count, not another event's", async () => {
    const { backend, publisher, tokens, state } = setup();
    backend.prints = [{ id: "a", takenAt: "2026-09-29T10:00:00.000Z" }];
    await publisher.publishIfDirty();
    tokens["new"] = "tok-new-0123456789abcd";
    state.activeId = "new";
    backend.prints = [];
    await publisher.publishIfDirty();
    expect(publisher.getStatus().photoCount).toBe(0);
  });

  it("does nothing without a token", async () => {
    const { backend, publisher } = setup({});
    await publisher.publishIfDirty();
    expect(backend.listed).toEqual([]);
    expect(publisher.getStatus()).toEqual({ enabled: false, photoCount: null, lastWrittenAt: null, lastError: null, failingSince: null });
  });
});

describe("album config", () => {
  const album = BoothConfigSchema.shape.album;

  it("is optional and defaults to no token", () => {
    expect(album.parse(undefined)).toEqual({});
  });

  it("takes a token of at least 16 URL-safe characters", () => {
    expect(album.parse({ token: TOKEN })).toEqual({ token: TOKEN });
    expect(() => album.parse({ token: "short" })).toThrow();
    expect(() => album.parse({ token: "has spaces in it, too long" })).toThrow();
  });
});
