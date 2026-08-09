import { v4 as uuidv4 } from "uuid";
import { dropIntoHotFolder } from "./hotFolder";
import { EventBus } from "../events/eventBus";
import { PrintSize } from "../config/schema";
import { OutboxStore } from "../outbox/outboxStore";
import { createLogger } from "../util/logger";

const log = createLogger("print:queue");

export interface PrintJobPublic {
  jobId: string;
  captureId: string;
  size: PrintSize;
  queuePosition: number;
  estimatedWaitMs: number;
}

interface InternalJob extends PrintJobPublic {
  enqueuedAt: number;
  failed: boolean;
}

/**
 * Fire-and-forget print submission. POST /print must return instantly so the
 * booth is free for the next guest - the actual file drop into the DNP hot
 * folder happens on a serialized background chain so prints still land in
 * the hot folder in the same order they were requested, without the caller
 * ever waiting on that I/O.
 *
 * Separately, `pending`/queue-position bookkeeping models the physical
 * printer as a serial device: dropping a file into the hot folder takes
 * milliseconds, but the DNP itself takes ~secondsPerPrint to actually
 * produce it, and we get no completion signal back from the Hot Folder
 * Print utility. A job is kept "pending" (and counted toward later jobs'
 * queue position/estimated wait) for that simulated duration, tracked via
 * `printerFreeAt` - a running total of when the real printer should be
 * done with everything queued ahead of it - independent of the (much
 * faster) file-drop chain below.
 */
export class PrintQueue {
  private pending: InternalJob[] = [];
  private processingChain: Promise<void> = Promise.resolve();
  private printerFreeAt = 0;

  constructor(
    private readonly hotFolderPath: string,
    private readonly secondsPerPrint: number,
    private readonly outbox: OutboxStore,
    private readonly eventBus: EventBus
  ) {}

  enqueue(captureId: string, size: PrintSize, compositeFilePath: string): PrintJobPublic {
    const jobId = uuidv4();
    const now = Date.now();
    const printDurationMs = this.secondsPerPrint * 1000;
    this.printerFreeAt = Math.max(this.printerFreeAt, now) + printDurationMs;
    const estimatedWaitMs = this.printerFreeAt - now;
    const queuePosition = this.pending.length + 1;

    const job: InternalJob = {
      jobId,
      captureId,
      size,
      queuePosition,
      estimatedWaitMs,
      enqueuedAt: now,
      failed: false,
    };
    this.pending.push(job);
    this.outbox.insertPrintJob({ id: jobId, captureId, size, filePath: compositeFilePath });

    this.eventBus.emit({
      type: "print-queued",
      jobId,
      size,
      queuePosition,
      estimatedWaitMs,
    });

    // Actual hand-off to the hot folder: immediate and ordered, never held up
    // by the simulated print duration below - the real printer should start
    // on it as soon as possible.
    this.processingChain = this.processingChain
      .then(() => dropIntoHotFolder(this.hotFolderPath, size, jobId, compositeFilePath))
      .then(() => {
        this.outbox.markPrintDropped(jobId);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed to drop print job ${jobId} into hot folder`, err);
        this.outbox.markPrintFailed(jobId);
        job.failed = true;
        this.removeFromPending(jobId);
        this.eventBus.emit({ type: "error", scope: "print-queue", message });
      });

    // Queue bookkeeping only: leaves `pending` once the printer would
    // realistically have finished this job.
    setTimeout(() => {
      if (job.failed) return;
      this.removeFromPending(jobId);
      this.eventBus.emit({ type: "print-completed", jobId });
    }, estimatedWaitMs);

    return { jobId, captureId, size, queuePosition, estimatedWaitMs };
  }

  getQueue(): PrintJobPublic[] {
    return this.pending.map((job, index) => ({
      jobId: job.jobId,
      captureId: job.captureId,
      size: job.size,
      queuePosition: index + 1,
      estimatedWaitMs: (index + 1) * this.secondsPerPrint * 1000,
    }));
  }

  private removeFromPending(jobId: string): void {
    this.pending = this.pending.filter((job) => job.jobId !== jobId);
  }
}
