import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BoothConfig } from "../config/schema";
import { CaptureRow } from "../outbox/types";

export function createSupabaseClient(config: BoothConfig["supabase"]): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: { persistSession: false },
  });
}

/**
 * Column mapping into the existing `captures` table. This agent does not own
 * the Supabase schema (see project constraints) - it was designed to a
 * plausible captures/events/presets/jobs/shares layout, but the exact column
 * names on the live table were not available while building this agent.
 * Verify/adjust the object below against the real schema before go-live;
 * this function is the ONLY place that needs to change.
 *
 * The upload/upsert mechanics in uploadCaptureToSupabase() below ARE verified
 * - tested end to end against a real local Supabase stack (Postgres + Storage
 * via the Supabase CLI/Docker), including the crash-and-retry path staying
 * idempotent (no duplicate rows or objects). That test surfaced a real
 * prerequisite worth calling out: an anon-key client gets nothing for free.
 * Whichever project this points at needs, for the `captures` table:
 *   `grant select, insert, update on captures to anon;`
 * and for the storage bucket (RLS on `storage.objects`, scoped to the bucket):
 *   INSERT and UPDATE policies for `anon` on `storage.objects` where
 *   `bucket_id = '<storageBucket>'` - UPDATE specifically, not just INSERT,
 *   because `upsert: true` re-uploading an already-existing key is an UPDATE
 *   as far as RLS is concerned, and denying it produces exactly the same
 *   error message as a missing INSERT policy, easy to misdiagnose.
 * If the real project already has a working booth UI reading/writing this
 * table, these almost certainly already exist - this is a checklist to
 * confirm, not a from-scratch setup.
 */
function toCaptureRecord(row: CaptureRow, storagePath: string): Record<string, unknown> {
  return {
    id: row.id,
    event_id: row.event_id,
    source: row.source,
    storage_path: storagePath,
    print_size: row.print_size,
    taken_at: row.taken_at,
  };
}

export async function uploadCaptureToSupabase(
  client: SupabaseClient,
  config: BoothConfig["supabase"],
  row: CaptureRow
): Promise<{ storagePath: string }> {
  const uploadSourcePath = row.composite_path ?? row.original_path;
  const fileBuffer = await readFile(uploadSourcePath);
  const objectKey = `${row.event_id}/${row.id}${path.extname(uploadSourcePath)}`;

  const { error: uploadError } = await client.storage
    .from(config.storageBucket)
    .upload(objectKey, fileBuffer, {
      contentType: "image/jpeg",
      upsert: true, // idempotent: a retried upload after a crash overwrites the same key
    });
  if (uploadError) {
    throw new Error(`Supabase Storage upload failed: ${uploadError.message}`);
  }

  const record = toCaptureRecord(row, objectKey);
  const { error: dbError } = await client.from("captures").upsert(record, { onConflict: "id" });
  if (dbError) {
    throw new Error(`Supabase captures upsert failed: ${dbError.message}`);
  }

  return { storagePath: objectKey };
}
