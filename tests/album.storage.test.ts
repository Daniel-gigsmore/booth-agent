import { describe, it, expect } from "vitest";
import { SupabaseClient } from "@supabase/supabase-js";
import { albumManifestKey, createSupabaseAlbumBackend } from "../src/supabase/albumStorage";

/** Just enough of supabase-js for the album backend, recording each call. */
function fakeClient(opts: { rows?: Array<{ id: string; taken_at: string }>; files?: string[]; queryError?: string; uploadError?: string } = {}) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, ...args: unknown[]) => { calls[name] = args; };
  const query = {
    select: (...args: unknown[]) => { record("select", ...args); return query; },
    eq: (...args: unknown[]) => { record("eq", ...args); return query; },
    not: (...args: unknown[]) => { record("not", ...args); return query; },
    order: (...args: unknown[]) => {
      record("order", ...args);
      return Promise.resolve(opts.queryError ? { data: null, error: { message: opts.queryError } } : { data: opts.rows ?? [], error: null });
    },
  };
  const bucket = {
    upload: async (...args: unknown[]) => { record("upload", ...args); return { error: opts.uploadError ? { message: opts.uploadError } : null }; },
    list: async (...args: unknown[]) => { record("list", ...args); return { data: (opts.files ?? []).map((name) => ({ name })), error: null }; },
    remove: async (...args: unknown[]) => { record("remove", ...args); return { error: null }; },
  };
  const client = {
    from: (...args: unknown[]) => { record("from", ...args); return query; },
    storage: { from: (...args: unknown[]) => { record("storage.from", ...args); return bucket; } },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("Supabase album backend", () => {
  it("lists this event's prints, oldest first", async () => {
    const { client, calls } = fakeClient({ rows: [{ id: "a", taken_at: "t1" }, { id: "b", taken_at: "t2" }] });
    const photos = await createSupabaseAlbumBackend(client, () => "captures").listPrints("evt");
    expect(photos).toEqual([{ id: "a", takenAt: "t1" }, { id: "b", takenAt: "t2" }]);
    expect(calls.from).toEqual(["captures"]);
    expect(calls.select).toEqual(["id, taken_at"]);
    expect(calls.eq).toEqual(["event_id", "evt"]);
    expect(calls.not).toEqual(["print_size", "is", null]);
    expect(calls.order).toEqual(["taken_at", { ascending: true }]);
  });

  it("throws when the query fails", async () => {
    const { client } = fakeClient({ queryError: "boom" });
    await expect(createSupabaseAlbumBackend(client, () => "captures").listPrints("evt")).rejects.toThrow("boom");
  });

  it("uploads the manifest as short-cached JSON at the token's key", async () => {
    const { client, calls } = fakeClient();
    const manifest = { updatedAt: "now", photos: [{ id: "a", takenAt: "t1" }] };
    await createSupabaseAlbumBackend(client, () => "captures").writeManifest("evt", "tok-0123456789abcdef", manifest);
    expect(calls["storage.from"]).toEqual(["captures"]);
    const [key, body, options] = calls.upload as [string, Buffer, object];
    expect(key).toBe("evt/albums/tok-0123456789abcdef.json");
    expect(JSON.parse(body.toString("utf8"))).toEqual(manifest);
    expect(options).toEqual({ contentType: "application/json", cacheControl: "10", upsert: true });
  });

  it("throws when the upload fails", async () => {
    const { client } = fakeClient({ uploadError: "denied" });
    await expect(
      createSupabaseAlbumBackend(client, () => "captures").writeManifest("evt", "t", { updatedAt: "now", photos: [] })
    ).rejects.toThrow("denied");
  });

  it("removes every other manifest in the album folder", async () => {
    const { client, calls } = fakeClient({ files: ["old-0123456789abcdef.json", "tok-0123456789abcdef.json"] });
    await createSupabaseAlbumBackend(client, () => "captures").removeOtherManifests("evt", "tok-0123456789abcdef");
    expect(calls.list).toEqual(["evt/albums"]);
    expect(calls.remove).toEqual([["evt/albums/old-0123456789abcdef.json"]]);
  });

  it("removes nothing when only the current manifest is there", async () => {
    const { client, calls } = fakeClient({ files: ["tok-0123456789abcdef.json"] });
    await createSupabaseAlbumBackend(client, () => "captures").removeOtherManifests("evt", "tok-0123456789abcdef");
    expect(calls.remove).toBeUndefined();
  });

  it("builds the manifest key", () => {
    expect(albumManifestKey("evt", "tok")).toBe("evt/albums/tok.json");
  });
});
