export type SyncStatus = "pending" | "uploading" | "synced" | "failed";

export interface CaptureRow {
  id: string;
  event_id: string;
  source: string;
  original_path: string;
  composite_path: string | null;
  print_size: string | null;
  taken_at: string;
  storage_path: string | null;
  sync_status: SyncStatus;
  sync_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  synced_at: string | null;
  created_at: string;
  /**
   * The local file that was actually uploaded on the last successful sync.
   * `sync_status = 'synced'` alone is not enough to know a row is finished:
   * a capture is usually uploaded as its original long before /composite has
   * produced the print-ready image, and the composite has to replace it.
   * Comparing this against composite_path is what detects that.
   */
  synced_source_path: string | null;
  /** Set when the row was given up on; excluded from the sync queue from then on. */
  sync_abandoned_at: string | null;
}

export interface NewCapture {
  id: string;
  eventId: string;
  source: string;
  originalPath: string;
  takenAt: string;
}

export interface SyncSummary {
  /** Rows that still owe Supabase an upload. Excludes abandoned rows. */
  queueDepth: number;
  lastSyncAt: string | null;
  /**
   * Most recent error from a row that is still being retried. Abandoned rows
   * are excluded on purpose - otherwise one dead capture pins an error string
   * to /health for the life of the deployment.
   */
  lastError: string | null;
  /** Rows given up on, reported separately so they can't hide in the backlog. */
  abandonedCount: number;
}

export type PrintJobStatus = "queued" | "dropped" | "failed";

export interface PrintJobRow {
  id: string;
  capture_id: string;
  size: string;
  file_path: string;
  status: PrintJobStatus;
  queued_at: string;
  dropped_at: string | null;
}
