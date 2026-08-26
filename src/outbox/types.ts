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
}

export interface NewCapture {
  id: string;
  eventId: string;
  source: string;
  originalPath: string;
  takenAt: string;
}

export interface SyncSummary {
  queueDepth: number;
  lastSyncAt: string | null;
  lastError: string | null;
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
