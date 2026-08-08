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
