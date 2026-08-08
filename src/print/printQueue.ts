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
}

/**
 * Fire-and-forget print submission. POST /print must return instantly so the
 * booth is free for the next guest - the actual file drop into the DNP hot
 * folder happens on a serialized background chain so prints still land in
 * the hot folder in the same order they were requested, without the caller
 * ever waiting on that I/O.
 */
export class PrintQueue {
  private pending: InternalJob[] = [];
  private processingChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly hotFolderPath: string,
    private readonly secondsPerPrint: number,
    private readonly outbox: OutboxStore,
    private readonly eventBus: EventBus
  ) {}

  enqueue(captureId: string, size: PrintSize, compositeFilePath: string): PrintJobPublic {
    const jobId = uuidv4();
    const queuePosition = this.pending.length + 1;
    const estimatedWaitMs = queuePosition * this.secondsPerPrint * 1000;

    const job: InternalJob = {
      jobId,
      captureId,
      size,
      queuePosition,
      estimatedWaitMs,
      enqueuedAt: Date.now(),
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

    // Chained, not awaited: enqueue() returns before this runs.
    this.processingChain = this.processingChain
      .then(() => dropIntoHotFolder(this.hotFolderPath, size, compositeFilePath))
      .then(() => {
        this.outbox.markPrintDropped(jobId);
        this.removeFromPending(jobId);
        this.eventBus.emit({ type: "print-completed", jobId });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed to drop print job ${jobId} into hot folder`, err);
        this.outbox.markPrintFailed(jobId);
        this.removeFromPending(jobId);
        this.eventBus.emit({ type: "error", scope: "print-queue", message });
      });

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
