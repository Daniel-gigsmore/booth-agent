import { OutboxStore } from "./outboxStore";
import { PermanentSyncError } from "./errors";
import { CaptureRow } from "./types";
import { EventBus } from "../events/eventBus";
import { createLogger } from "../util/logger";

const log = createLogger("outbox:sync");

export interface SyncWorkerConfig {
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffMultiplier: number;
  batchSize: number;
  tickIntervalMs?: number;
}

/**
 * Returns the storage key written AND the local file that was uploaded to get
 * there. The second value is not bookkeeping: the row can gain a composite
 * while this upload is in flight, so "what did we actually send" is the only
 * thing that can tell the next pass whether the row is finished.
 */
export type UploadFn = (row: CaptureRow) => Promise<{ storagePath: string; sourcePath: string }>;

/**
 * Polls the outbox for due rows and uploads them, backing off exponentially
 * per-row on failure (network down, Supabase unreachable, etc). Injecting
 * `uploadFn` instead of a real Supabase client keeps this fully unit
 * testable: a test can simulate "offline for N attempts, then back online"
 * without any network or SQLite-on-disk dependency.
 */
export class SyncWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly tickIntervalMs: number;
  private consecutiveFailures = 0;

  constructor(
    private readonly store: OutboxStore,
    private readonly uploadFn: UploadFn,
    private readonly config: SyncWorkerConfig,
    private readonly eventBus: EventBus
  ) {
    this.tickIntervalMs = config.tickIntervalMs ?? 2000;
  }

  start(): void {
    const resetCount = this.store.resetStuckUploads();
    if (resetCount > 0) {
      log.warn(`Reset ${resetCount} capture(s) stuck mid-upload from a previous run`);
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs one sync pass. Exposed directly so tests can drive it deterministically. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const batch = this.store.getBatchDue(this.config.batchSize);
      for (const row of batch) {
        await this.syncOne(row);
      }
      this.emitStatus();
    } finally {
      this.running = false;
    }
  }

  private async syncOne(row: CaptureRow): Promise<void> {
    this.store.markUploading(row.id);
    try {
      const { storagePath, sourcePath } = await this.uploadFn(row);
      this.store.markSynced(row.id, storagePath, sourcePath);
      this.consecutiveFailures = 0;
      log.info(`Synced capture ${row.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error ? err.cause : undefined;

      // Retrying this one forever would never succeed, and would hold
      // queueDepth above zero and lastError populated for the life of the
      // deployment - a permanent warning the operator can do nothing about,
      // which is how they learn to stop reading warnings. Take it out of the
      // queue and report it as its own thing instead.
      //
      // Note this does NOT increment consecutiveFailures: one missing file
      // says nothing about the network, and flipping `online` to false over
      // it would misreport a perfectly healthy connection.
      if (err instanceof PermanentSyncError) {
        this.store.markAbandoned(row.id, message);
        log.error(`Giving up on capture ${row.id}: ${message}`);
        this.eventBus.emit({
          type: "error",
          scope: "sync",
          message: `capture ${row.id} can never be uploaded: ${message}`,
        });
        return;
      }

      this.consecutiveFailures += 1;
      const attemptNumber = row.sync_attempts + 1;
      const delay = Math.min(
        this.config.maxBackoffMs,
        this.config.initialBackoffMs * this.config.backoffMultiplier ** (attemptNumber - 1)
      );
      const nextAttemptAt = new Date(Date.now() + delay).toISOString();
      this.store.markFailed(row.id, message, nextAttemptAt);
      log.warn(`Sync failed for capture ${row.id}, retrying in ${delay}ms`, {
        message,
        causeName: cause instanceof Error ? cause.name : undefined,
        causeMessage: cause instanceof Error ? cause.message : undefined,
        causeCode: (cause as NodeJS.ErrnoException | undefined)?.code,
        causeErrno: (cause as NodeJS.ErrnoException | undefined)?.errno,
        causeSyscall: (cause as NodeJS.ErrnoException | undefined)?.syscall,
      });
    }
  }

  private emitStatus(): void {
    const summary = this.store.getSyncSummary();
    this.eventBus.emit({
      type: "sync-status",
      queueDepth: summary.queueDepth,
      lastSyncAt: summary.lastSyncAt,
      lastError: summary.lastError,
      abandonedCount: summary.abandonedCount,
      online: this.consecutiveFailures === 0,
    });
  }
}
