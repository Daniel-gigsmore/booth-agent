import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BoothConfig } from "../config/schema";
import { CaptureRow } from "../outbox/types";

export function createSupabaseClient(config: BoothConfig["supabase"]): SupabaseClient {
  return createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * supabase-js wraps a failed fetch in its own error type (e.g.
 * StorageUnknownError), which flattens the real cause down to just
 * `.message` ("fetch failed" - undici's generic wrapper message) while the
 * actual reason (ECONNRESET, ENOTFOUND, UNABLE_TO_VERIFY_LEAF_SIGNATURE,
 * etc.) sits several levels deeper, alternating between `.originalError`
 * (supabase-js's own nesting) and `.cause` (undici's). Walk both until
 * nothing's left to unwrap, so callers can attach the actual bottom-most
 * error as `cause` instead of the message-only wrapper.
 */
function unwrapError(err: unknown): unknown {
  let current = err;
  for (;;) {
    if (!current || typeof current !== "object") return current;
    const next = (current as { cause?: unknown; originalError?: unknown }).cause ??
      (current as { cause?: unknown; originalError?: unknown }).originalError;
    if (!next) return current;
    current = next;
  }
}

/**
 * Column mapping into the `captures` table - see
 * supabase/migrations/20260814000000_captures.sql for the schema this
 * targets (verified live against the real project: id uuid, event_id text,
 * source text, storage_path text, print_size text, taken_at timestamptz).
 *
 * The upload/upsert mechanics in uploadCaptureToSupabase() below ARE verified
 * - tested end to end against a real local Supabase stack (Postgres + Storage
 * via the Supabase CLI/Docker), including the crash-and-retry path staying
 * idempotent (no duplicate rows or objects). booth-agent connects with the
 * service_role key (see createSupabaseClient above), which bypasses RLS by
 * default, so unlike an anon-key client it needs no explicit grants/policies
 * of its own to insert/update `captures` or write into the storage bucket.
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
    throw new Error(`Supabase Storage upload failed: ${uploadError.message}`, { cause: unwrapError(uploadError) });
  }

  const record = toCaptureRecord(row, objectKey);
  const { error: dbError } = await client.from("captures").upsert(record, { onConflict: "id" });
  if (dbError) {
    throw new Error(`Supabase captures upsert failed: ${dbError.message}`, { cause: unwrapError(dbError) });
  }

  return { storagePath: objectKey };
}
