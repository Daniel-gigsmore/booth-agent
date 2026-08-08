import type { DatabaseSync } from "./db";
import { CaptureRow, NewCapture, SyncStatus, SyncSummary } from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * All reads/writes against the local outbox. This is the single source of
 * truth on disk: a capture exists here the instant the file is written, long
 * before (or entirely without) a successful upload.
 */
export class OutboxStore {
  constructor(private readonly db: DatabaseSync) {}

  insertCapture(capture: NewCapture): CaptureRow {
    this.db
      .prepare(
        `INSERT INTO captures (id, event_id, source, original_path, taken_at, sync_status, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(capture.id, capture.eventId, capture.source, capture.originalPath, capture.takenAt, capture.takenAt);
    return this.getById(capture.id) as CaptureRow;
  }

  setCompositePath(captureId: string, compositePath: string, printSize: string): void {
    this.db
      .prepare(`UPDATE captures SET composite_path = ?, print_size = ? WHERE id = ?`)
      .run(compositePath, printSize, captureId);
  }

  getById(id: string): CaptureRow | undefined {
    const row = this.db.prepare(`SELECT * FROM captures WHERE id = ?`).get(id);
    return row as unknown as CaptureRow | undefined;
  }

  /** Rows due for an upload attempt now, oldest first, capped at batchSize. */
  getBatchDue(batchSize: number): CaptureRow[] {
    const now = nowIso();
    const rows = this.db
      .prepare(
        `SELECT * FROM captures
         WHERE sync_status IN ('pending', 'failed') AND next_attempt_at <= ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(now, batchSize);
    return rows as unknown as CaptureRow[];
  }

  markUploading(id: string): void {
    this.setStatus(id, "uploading");
  }

  markSynced(id: string, storagePath: string): void {
    this.db
      .prepare(
        `UPDATE captures
         SET sync_status = 'synced', storage_path = ?, synced_at = ?, last_error = NULL
         WHERE id = ?`
      )
      .run(storagePath, nowIso(), id);
  }

  markFailed(id: string, error: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `UPDATE captures
         SET sync_status = 'failed', sync_attempts = sync_attempts + 1,
             last_error = ?, next_attempt_at = ?
         WHERE id = ?`
      )
      .run(error, nextAttemptAt, id);
  }

  /** Rows stuck mid-upload from a crash get put back in the queue on startup. */
  resetStuckUploads(): number {
    const result = this.db
      .prepare(`UPDATE captures SET sync_status = 'pending' WHERE sync_status = 'uploading'`)
      .run();
    return Number(result.changes);
  }

  private setStatus(id: string, status: SyncStatus): void {
    this.db.prepare(`UPDATE captures SET sync_status = ? WHERE id = ?`).run(status, id);
  }

  getSyncSummary(): SyncSummary {
    const countRow = this.db
      .prepare(`SELECT COUNT(*) as n FROM captures WHERE sync_status != 'synced'`)
      .get() as unknown as { n: number };
    const lastSynced = this.db
      .prepare(`SELECT synced_at FROM captures WHERE synced_at IS NOT NULL ORDER BY synced_at DESC LIMIT 1`)
      .get() as unknown as { synced_at: string } | undefined;
    const lastFailed = this.db
      .prepare(`SELECT last_error FROM captures WHERE last_error IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
      .get() as unknown as { last_error: string } | undefined;
    return {
      queueDepth: countRow.n,
      lastSyncAt: lastSynced?.synced_at ?? null,
      lastError: lastFailed?.last_error ?? null,
    };
  }

  insertPrintJob(job: { id: string; captureId: string; size: string; filePath: string }): void {
    this.db
      .prepare(
        `INSERT INTO print_jobs (id, capture_id, size, file_path, status)
         VALUES (?, ?, ?, ?, 'queued')`
      )
      .run(job.id, job.captureId, job.size, job.filePath);
  }

  markPrintDropped(id: string): void {
    this.db
      .prepare(`UPDATE print_jobs SET status = 'dropped', dropped_at = ? WHERE id = ?`)
      .run(nowIso(), id);
  }

  markPrintFailed(id: string): void {
    this.db.prepare(`UPDATE print_jobs SET status = 'failed' WHERE id = ?`).run(id);
  }
}
