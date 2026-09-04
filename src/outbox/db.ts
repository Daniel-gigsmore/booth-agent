import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Imported via require() rather than `import` so bundler/test-runner tooling
// (Vite/esbuild under Vitest) doesn't try to statically resolve "node:sqlite"
// as a package - it's a Node builtin, and `require` reaches it directly.
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
export type DatabaseSync = DatabaseSyncType;

/**
 * Opens (creating if needed) the local outbox database using Node's built-in
 * node:sqlite - deliberately not a native npm module. On the target Windows
 * mini-PC this means zero native-addon/ABI risk (no Visual Studio build
 * tools required to install or update the agent), which matters for a
 * device that has to keep working unattended in a booth. WAL mode keeps
 * writers and readers from blocking each other, since the HTTP server reads
 * /health queue depth while the sync worker is writing.
 */
export function openOutboxDb(dataDir: string, fileName: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, fileName);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/** In-memory database for tests - same schema, no filesystem touched. */
export function createInMemoryOutboxDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS captures (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      source TEXT NOT NULL,
      original_path TEXT NOT NULL,
      composite_path TEXT,
      print_size TEXT,
      taken_at TEXT NOT NULL,
      storage_path TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (sync_status IN ('pending', 'uploading', 'synced', 'failed')),
      sync_attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_error TEXT,
      synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      synced_source_path TEXT,
      sync_abandoned_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_captures_sync_status
      ON captures (sync_status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      capture_id TEXT NOT NULL REFERENCES captures (id),
      size TEXT NOT NULL CHECK (size IN ('4x6', '2x6-strip')),
      file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'dropped', 'failed')),
      queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      dropped_at TEXT
    );
  `);

  // The CREATE TABLE above is IF NOT EXISTS, so it does nothing at all on a
  // booth PC that already has an outbox.db from a previous version - any
  // column added to it later has to arrive this way instead. Additive and
  // idempotent by design: no table rebuild, so the print_jobs foreign key
  // into captures is never disturbed.
  ensureColumn(db, "captures", "synced_source_path", "TEXT");
  ensureColumn(db, "captures", "sync_abandoned_at", "TEXT");

  // Existing rows predate synced_source_path and have it NULL, and nothing on
  // disk records which file they actually uploaded (storage_path is the same
  // key either way). Only one case can be resolved from what is stored: a
  // synced row that was never composited can only have uploaded its original,
  // so mark it finished. A synced row that DOES have a composite is left NULL
  // on purpose - that is exactly the population this fix exists for, and NULL
  // reads as "re-upload the composite", which repairs them on the first sync
  // pass after the upgrade. Rows that had already uploaded their composite
  // (the offline path, where the drain happened after compositing) are
  // re-uploaded once too; the storage key is unchanged and the upsert
  // overwrites the same object with identical bytes.
  db.exec(`
    UPDATE captures
    SET synced_source_path = original_path
    WHERE sync_status = 'synced' AND synced_source_path IS NULL AND composite_path IS NULL
  `);
}

/** Adds a column only if the table doesn't already have it. */
function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
