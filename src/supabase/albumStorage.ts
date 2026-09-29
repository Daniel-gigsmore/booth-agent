import { SupabaseClient } from "@supabase/supabase-js";
import { AlbumBackend, AlbumManifest } from "../album/albumPublisher";

/** The album manifest sits beside the event's photos: `<event>/albums/<token>.json`. */
export function albumManifestKey(eventId: string, token: string): string {
  return `${eventId}/albums/${token}.json`;
}

/**
 * Where the album manifest is written. Which photos go in it comes from the local outbox
 * (OutboxStore.listPublishedPrints), because only the booth knows which composites were printed.
 */
export function createSupabaseAlbumBackend(client: SupabaseClient, bucket: () => string): Omit<AlbumBackend, "listPrints"> {
  return {
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
