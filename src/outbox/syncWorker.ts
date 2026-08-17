import { OutboxStore } from "./outboxStore";
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

export type UploadFn = (row: CaptureRow) => Promise<{ storagePath: string }>;

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
      const { storagePath } = await this.uploadFn(row);
      this.store.markSynced(row.id, storagePath);
      this.consecutiveFailures = 0;
      log.info(`Synced capture ${row.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error ? err.cause : undefined;
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
      online: this.consecutiveFailures === 0,
    });
  }
}
