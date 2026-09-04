import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";

const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

/**
 * The booth PC already has an outbox.db from the previous version, and the
 * schema block is `CREATE TABLE IF NOT EXISTS` - it does nothing at all on
 * that file. Any column added later has to arrive via ALTER TABLE, and
 * getting the backfill wrong is expensive in both directions: too eager and
 * every historical capture re-uploads on the first boot after the upgrade,
 * too lazy and the captures this fix exists for stay broken forever.
 */
const OLD_SCHEMA = `
  CREATE TABLE captures (
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
  CREATE TABLE print_jobs (
    id TEXT PRIMARY KEY,
    capture_id TEXT NOT NULL REFERENCES captures (id),
    size TEXT NOT NULL CHECK (size IN ('4x6', '2x6-strip')),
    file_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'dropped', 'failed')),
    queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    dropped_at TEXT
  );
`;

let dir: string;
// node:sqlite holds an open file handle until .close(). POSIX allows
// unlinking an open file, so this was invisible wherever the patch this
// test came in on was run - but on Windows an open handle blocks deleting
// its containing directory (EPERM), which is exactly what rmSync below
// does on every test. Each test that opens a db via openOutboxDb() must
// record it here so afterEach can close it before cleanup runs.
let openDb: ReturnType<typeof openOutboxDb> | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "booth-migration-"));
});

afterEach(() => {
  openDb?.close();
  openDb = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function seedOldDb(rows: Array<{ id: string; composite: string | null; status: string }>) {
  const db = new DatabaseSync(path.join(dir, "outbox.db"));
  db.exec(OLD_SCHEMA);
  for (const row of rows) {
    db.prepare(
      `INSERT INTO captures (id, event_id, source, original_path, composite_path, taken_at, sync_status, synced_at)
       VALUES (?, 'past-event', 'canon', ?, ?, '2026-08-01T00:00:00.000Z', ?, '2026-08-01T00:01:00.000Z')`
    ).run(row.id, `/data/originals/${row.id}.jpg`, row.composite, row.status);
  }
  db.close();
}

describe("upgrading an existing outbox.db", () => {
  it("adds the new columns to a database created by the previous version", () => {
    seedOldDb([{ id: "old-1", composite: null, status: "synced" }]);

    const db = openOutboxDb(dir, "outbox.db");
    const columns = (
      db.prepare("PRAGMA table_info(captures)").all() as unknown as Array<{ name: string }>
    ).map((c) => c.name);
    db.close();

    expect(columns).toContain("synced_source_path");
    expect(columns).toContain("sync_abandoned_at");
  });

  it("leaves already-finished history alone instead of re-uploading it", () => {
    seedOldDb([
      { id: "old-plain", composite: null, status: "synced" },
      { id: "old-pending", composite: null, status: "pending" },
    ]);

    openDb = openOutboxDb(dir, "outbox.db");
    const store = new OutboxStore(openDb);
    // Only the never-composited synced row is provably done, and it stays done.
    expect(store.getById("old-plain")?.synced_source_path).toBe("/data/originals/old-plain.jpg");
    expect(store.getBatchDue(10).map((r) => r.id)).toEqual(["old-pending"]);
  });

  it("re-queues the captures the old code stranded: synced as original, composite never sent", () => {
    seedOldDb([{ id: "old-victim", composite: "/data/composites/c1.jpg", status: "synced" }]);

    openDb = openOutboxDb(dir, "outbox.db");
    const store = new OutboxStore(openDb);
    expect(store.getBatchDue(10).map((r) => r.id)).toEqual(["old-victim"]);
    expect(store.getSyncSummary().queueDepth).toBe(1);
  });

  it("is idempotent - opening the same database twice changes nothing", () => {
    seedOldDb([{ id: "old-1", composite: null, status: "synced" }]);

    openOutboxDb(dir, "outbox.db").close();
    openDb = openOutboxDb(dir, "outbox.db");
    const store = new OutboxStore(openDb);
    expect(store.getById("old-1")?.synced_source_path).toBe("/data/originals/old-1.jpg");
    expect(store.getBatchDue(10)).toHaveLength(0);
  });
});
