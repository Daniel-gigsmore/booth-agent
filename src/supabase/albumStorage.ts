import { SupabaseClient } from "@supabase/supabase-js";
import { AlbumBackend, AlbumManifest, AlbumPhoto } from "../album/albumPublisher";

/** The album manifest sits beside the event's photos: `<event>/albums/<token>.json`. */
export function albumManifestKey(eventId: string, token: string): string {
  return `${eventId}/albums/${token}.json`;
}

/**
 * The album manifest in Supabase. It reads the `captures` table rather than the local outbox so
 * the album is complete even if this PC's data folder was reset, and lists only prints that are
 * really in the bucket: a row only gets print_size once its composite has uploaded.
 */
export function createSupabaseAlbumBackend(client: SupabaseClient, bucket: () => string): AlbumBackend {
  return {
    async listPrints(eventId: string): Promise<AlbumPhoto[]> {
      const { data, error } = await client
        .from("captures")
        .select("id, taken_at")
        .eq("event_id", eventId)
        .not("print_size", "is", null)
        .order("taken_at", { ascending: true });
      if (error) throw new Error(`album query failed: ${error.message}`);
      return ((data ?? []) as Array<{ id: string; taken_at: string }>).map((row) => ({ id: row.id, takenAt: row.taken_at }));
    },

    async writeManifest(eventId: string, token: string, manifest: AlbumManifest): Promise<void> {
      const { error } = await client.storage
        .from(bucket())
        .upload(albumManifestKey(eventId, token), Buffer.from(JSON.stringify(manifest), "utf8"), {
          contentType: "application/json",
          cacheControl: "10",
          upsert: true,
        });
      if (error) throw new Error(`album upload failed: ${error.message}`);
    },

    async removeOtherManifests(eventId: string, keepToken: string): Promise<void> {
      const folder = `${eventId}/albums`;
      const { data, error } = await client.storage.from(bucket()).list(folder);
      if (error) throw new Error(`album list failed: ${error.message}`);
      const stale = (data ?? []).map((file) => file.name).filter((name) => name !== `${keepToken}.json`);
      if (stale.length === 0) return;
      const { error: removeError } = await client.storage.from(bucket()).remove(stale.map((name) => `${folder}/${name}`));
      if (removeError) throw new Error(`album cleanup failed: ${removeError.message}`);
    },
  };
}
