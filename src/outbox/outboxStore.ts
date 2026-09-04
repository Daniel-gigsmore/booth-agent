import type { DatabaseSync } from "./db";
import { CaptureRow, NewCapture, PrintJobRow, SyncStatus, SyncSummary } from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A capture still owes Supabase an upload if it has never synced, OR if it
 * has synced but the file we would send now isn't the file that went up.
 *
 * That second clause is the whole point. `POST /capture` inserts the row and
 * the sync worker can claim it within a tick or two - long before a guest has
 * finished choosing a template and `/composite` has produced the print-ready
 * image. Under the old `sync_status = 'synced'` test the row was finished
 * forever at that moment, so on any capture taken with a working network the
 * branded composite and its print_size never reached Supabase at all; only
 * the raw original did. It only looked correct offline, where the queue
 * drains long after compositing.
 *
 * Comparing against the file that was actually uploaded makes this
 * order-independent: whichever of the two happens first, the row is finished
 * exactly when composite_path is what sits in Storage.
 */
const NEEDS_UPLOAD_SQL = `
  sync_abandoned_at IS NULL
  AND (
    sync_status IN ('pending', 'failed', 'uploading')
    OR (
      composite_path IS NOT NULL
      AND (synced_source_path IS NULL OR synced_source_path <> composite_path)
    )
  )`;

/** NEEDS_UPLOAD_SQL, minus rows already in flight or waiting out a backoff. */
const DUE_FOR_UPLOAD_SQL = `
  sync_abandoned_at IS NULL
  AND sync_status <> 'uploading'
  AND next_attempt_at <= ?
  AND (
    sync_status IN ('pending', 'failed')
    OR (
      composite_path IS NOT NULL
      AND (synced_source_path IS NULL OR synced_source_path <> composite_path)
    )
  )`;

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

  /**
   * Deliberately does not touch sync_status. Flipping an already-synced row
   * back to 'pending' here would race the sync worker: if the original's
   * upload is in flight at this moment, its markSynced() lands afterwards and
   * silently overwrites the re-queue. NEEDS_UPLOAD_SQL derives the same thing
   * from data that can't be clobbered - composite_path versus the path that
   * was actually uploaded - so the ordering of these two writes stops
   * mattering.
   */
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
         WHERE ${DUE_FOR_UPLOAD_SQL}
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(now, batchSize);
    return rows as unknown as CaptureRow[];
  }

  markUploading(id: string): void {
    this.setStatus(id, "uploading");
  }

  /**
   * `sourcePath` is the local file that was actually uploaded, not the one we
   * would pick today - the row may have gained a composite while the upload
   * was in flight, and recording what went up (rather than what is current)
   * is what lets the next pass notice the difference and push the composite.
   *
   * sync_attempts/next_attempt_at are reset so a row that struggled on its
   * original doesn't inherit a two-minute backoff when its composite arrives.
   */
  markSynced(id: string, storagePath: string, sourcePath: string): void {
    this.db
      .prepare(
        `UPDATE captures
         SET sync_status = 'synced', storage_path = ?, synced_source_path = ?,
             synced_at = ?, last_error = NULL, sync_attempts = 0, next_attempt_at = ?
         WHERE id = ?`
      )
      .run(storagePath, sourcePath, nowIso(), nowIso(), id);
  }

  /**
   * Take a row out of the retry loop for good. Reserved for failures that
   * cannot be fixed by waiting - see PermanentSyncError. Retryable failures
   * keep retrying with no attempt cap, because being offline for an entire
   * event is a supported state, not an error.
   */
  markAbandoned(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE captures
         SET sync_status = 'failed', sync_attempts = sync_attempts + 1,
             last_error = ?, sync_abandoned_at = ?
         WHERE id = ?`
      )
      .run(error, nowIso(), id);
  }

  getAbandoned(): CaptureRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM captures WHERE sync_abandoned_at IS NOT NULL ORDER BY created_at ASC`)
      .all();
    return rows as unknown as CaptureRow[];
  }

  /**
   * Puts every abandoned row back in the queue. The realistic reason to call
   * this is that the files were somewhere else all along (a data dir moved,
   * an external drive remounted) and are now back where the row points.
   */
  retryAbandoned(): number {
    const result = this.db
      .prepare(
        `UPDATE captures
         SET sync_abandoned_at = NULL, sync_status = 'pending', sync_attempts = 0, next_attempt_at = ?
         WHERE sync_abandoned_at IS NOT NULL`
      )
      .run(nowIso());
    return Number(result.changes);
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
      .prepare(`SELECT COUNT(*) as n FROM captures WHERE ${NEEDS_UPLOAD_SQL}`)
      .get() as unknown as { n: number };
    const abandonedRow = this.db
      .prepare(`SELECT COUNT(*) as n FROM captures WHERE sync_abandoned_at IS NOT NULL`)
      .get() as unknown as { n: number };
    const lastSynced = this.db
      .prepare(`SELECT synced_at FROM captures WHERE synced_at IS NOT NULL ORDER BY synced_at DESC LIMIT 1`)
      .get() as unknown as { synced_at: string } | undefined;
    // Abandoned rows are excluded: they keep their last_error for diagnosis
    // via GET /sync/abandoned, but letting one dead capture pin an error
    // string to /health forever is exactly the alert fatigue healthReport.ts
    // is written to avoid.
    const lastFailed = this.db
      .prepare(
        `SELECT last_error FROM captures
         WHERE last_error IS NOT NULL AND sync_abandoned_at IS NULL
         ORDER BY created_at DESC LIMIT 1`
      )
      .get() as unknown as { last_error: string } | undefined;
    return {
      queueDepth: countRow.n,
      lastSyncAt: lastSynced?.synced_at ?? null,
      lastError: lastFailed?.last_error ?? null,
      abandonedCount: abandonedRow.n,
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

  getPrintJobById(id: string): PrintJobRow | undefined {
    const row = this.db.prepare(`SELECT * FROM print_jobs WHERE id = ?`).get(id);
    return row as unknown as PrintJobRow | undefined;
  }

  getQueuedPrintJobs(): PrintJobRow[] {
    const rows = this.db.prepare(`SELECT * FROM print_jobs WHERE status = 'queued'`).all();
    return rows as unknown as PrintJobRow[];
  }

  /**
   * Jobs still 'queued' on startup were mid-flight when the process died -
   * whether the file actually landed in the hot folder before the crash
   * can't be determined after the fact, so these are marked failed rather
   * than silently reprinted or left ambiguous. Mirrors resetStuckUploads()
   * for the outbox sync path.
   */
  resolveInterruptedPrintJobs(): PrintJobRow[] {
    const interrupted = this.getQueuedPrintJobs();
    this.db.prepare(`UPDATE print_jobs SET status = 'failed' WHERE status = 'queued'`).run();
    return interrupted;
  }

  /**
   * Most recent print job for a capture. Reprints are usually asked for as
   * "print that one again" while the guest is still standing there, so the
   * operator has a capture in front of them, not a job id.
   */
  getLatestPrintJobForCapture(captureId: string): PrintJobRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM print_jobs WHERE capture_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT 1`
      )
      .get(captureId);
    return row as unknown as PrintJobRow | undefined;
  }

  /**
   * Recent print history, newest first. This is what an operator scans after
   * a media change to work out which prints were dropped into the hot folder
   * while the printer had no paper and therefore never physically came out.
   */
  getRecentPrintJobs(limit: number): PrintJobRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM print_jobs ORDER BY queued_at DESC, rowid DESC LIMIT ?`)
      .all(limit);
    return rows as unknown as PrintJobRow[];
  }
}
