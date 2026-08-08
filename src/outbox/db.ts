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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
}
