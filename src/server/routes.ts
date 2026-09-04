import { Router, Request, Response } from "express";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { AgentContext } from "./context";
import { asyncHandler } from "./asyncHandler";
import { writeBackpressureAware } from "./streamWrite";
import { PrintSizeSchema } from "../config/schema";
import { loadTemplate, resolveOverlayPath } from "../compositor/template";
import { renderComposite } from "../compositor/compositor";
import { originalsDir, compositesDir, aiDownloadsDir } from "../util/paths";
import { isHotFolderWritable } from "../print/hotFolder";
import { readPrinterStatus, defaultPrinterStatusPath } from "../print/printerStatus";
import { buildHealthReport } from "../health/healthReport";
import { runPreflight, logPreflight } from "../startup/preflight";
import { getDiskSpace } from "../util/disk";
import { createLogger } from "../util/logger";

const log = createLogger("server:routes");

const CompositeRequestSchema = z.object({
  captureId: z.string().min(1),
  templateId: z.string().min(1),
  printSize: PrintSizeSchema.optional(),
  aiOutputUrl: z.string().url().optional(),
});

const PrintRequestSchema = z.object({
  captureId: z.string().min(1),
  size: PrintSizeSchema.optional(),
});

/**
 * A reprint can be asked for either way round: by job id (from print history,
 * e.g. re-running everything queued while the printer was out of paper) or by
 * capture id (the common case - the guest is still standing there and the
 * print came out badly). Exactly one is required.
 */
const ReprintRequestSchema = z
  .object({
    jobId: z.string().min(1).optional(),
    captureId: z.string().min(1).optional(),
    size: PrintSizeSchema.optional(),
    copies: z.number().int().min(1).max(5).default(1),
  })
  .refine((body) => Boolean(body.jobId) !== Boolean(body.captureId), {
    message: "provide exactly one of jobId or captureId",
  });

export function buildRouter(ctx: AgentContext): Router {
  const router = Router();

  router.get("/health", asyncHandler(async (_req: Request, res: Response) => {
    const config = ctx.configStore.current;
    const cameraStatus = ctx.cameraManager.getStatus();
    const [hotFolderWritable, diskSpace, printerStatus] = await Promise.all([
      isHotFolderWritable(config.printing.hotFolderPath),
      getDiskSpace(config.storage.dataDir),
      readPrinterStatus({
        statusFilePath:
          config.printing.printerStatusPath ??
          defaultPrinterStatusPath(config.printing.hotFolderPath),
        staleAfterMs: config.printing.printerStatusStaleMs,
      }),
    ]);

    res.json(
      buildHealthReport({
        camera: cameraStatus,
        hotFolder: {
          path: config.printing.hotFolderPath,
          writable: hotFolderWritable,
        },
        printer: printerStatus,
        disk: diskSpace,
        outbox: ctx.outboxStore.getSyncSummary(),
        eventId: config.event.id,
        thresholds: {
          lowDiskWarnBytes: config.storage.lowDiskWarnBytes,
          lowMediaWarnPrints: config.printing.lowMediaWarnPrints,
          outboxBacklogWarn: config.sync.backlogWarnCount,
          expectedMediaType: config.printing.expectedMediaType,
        },
      })
    );
  }));

  /**
   * The boot-time preflight result, kept verbatim from startup. Useful from a
   * phone on the venue wifi: "why is the tray red" answered without RDPing
   * into the booth PC.
   */
  router.get("/health/preflight", (_req: Request, res: Response) => {
    res.json(ctx.preflight);
  });

  /**
   * Re-run preflight now and replace the stored result.
   *
   * The boot-time run is structurally pessimistic: this service starts as
   * LocalSystem at boot, while HotFolderPrint.exe and the printer only come up
   * later in the interactive session, so anything depending on them reads as
   * unverifiable at boot. This is the endpoint the operator hits once the
   * booth is actually set up - camera plugged in, printer on, HFP running -
   * to get the answer that means something.
   *
   * Belongs in the pre-event runbook: set everything up, POST this, expect ok.
   */
  router.post("/health/preflight", asyncHandler(async (_req: Request, res: Response) => {
    const result = await runPreflight(ctx.configStore.current);
    logPreflight(result);
    ctx.preflight = result;
    res.json(result);
  }));

  router.get("/liveview", asyncHandler(async (req: Request, res: Response) => {
    const boundary = "boothagentframe";
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Connection: "close",
    });

    let closed = false;
    req.on("close", () => {
      closed = true;
    });
    // A socket reset mid-write emits on the response. With no listener that
    // becomes an uncaught 'error' event, which is a process-level crash, not
    // a failed request - and a kiosk browser dropping an MJPEG stream is a
    // completely routine thing to happen.
    res.on("error", () => {
      closed = true;
    });

    // The stream is open-ended, so this is the one handler that has to clean
    // up after itself: without the finally the connection is left half-open
    // on any throw, and the response never ends.
    try {
      while (!closed && !res.writableEnded && !res.destroyed) {
        const result = await ctx.cameraManager.getLiveviewFrame();
        if (result) {
          const header =
            `--${boundary}\r\n` +
            `Content-Type: image/jpeg\r\n` +
            `Content-Length: ${result.frame.length}\r\n\r\n`;
          res.write(header);
          res.write(result.frame);
          // write() returning false means the kernel buffer is full - i.e.
          // the client is consuming frames slower than we produce them.
          // Pushing on regardless queues JPEGs in memory for as long as that
          // client stays connected, so wait for it to catch up instead - see
          // writeBackpressureAware() for why this can't just await "drain".
          // The while loop's own !res.destroyed check is what ends the loop
          // once this unblocks via a client disconnect.
          await writeBackpressureAware(res, "\r\n");
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }));

  router.post("/capture", asyncHandler(async (_req: Request, res: Response) => {
    const config = ctx.configStore.current;
    try {
      const captureId = uuidv4();
      const result = await ctx.cameraManager.capture(originalsDir(config));
      const takenAt = new Date().toISOString();

      ctx.outboxStore.insertCapture({
        id: captureId,
        eventId: config.event.id,
        source: result.source,
        originalPath: result.filePath,
        takenAt,
      });

      ctx.eventBus.emit({
        type: "capture-taken",
        captureId,
        filePath: result.filePath,
        source: result.source,
        takenAt,
      });

      res.status(201).json({
        captureId,
        filePath: result.filePath,
        width: result.width,
        height: result.height,
        source: result.source,
        takenAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Capture failed", err);
      ctx.eventBus.emit({ type: "error", scope: "capture", message });
      res.status(503).json({ error: message });
    }
  }));

  router.post("/composite", asyncHandler(async (req: Request, res: Response) => {
    const config = ctx.configStore.current;
    const parsed = CompositeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { captureId, templateId, aiOutputUrl } = parsed.data;
    const printSize = parsed.data.printSize ?? config.printing.defaultSize;

    const row = ctx.outboxStore.getById(captureId);
    if (!row) {
      res.status(404).json({ error: `capture ${captureId} not found` });
      return;
    }

    try {
      const sourceImagePath = aiOutputUrl
        ? await downloadAiOutput(aiOutputUrl, aiDownloadsDir(config), config.supabase.url)
        : row.original_path;

      const template = loadTemplate(config.compositing.templateDir, templateId);
      const overlayPath = resolveOverlayPath(config.compositing.templateDir, template);

      const result = await renderComposite({
        sourceImagePath,
        template,
        overlayPath,
        printSize,
        outputDir: compositesDir(config),
        jpegQuality: config.compositing.jpegQuality,
      });

      ctx.outboxStore.setCompositePath(captureId, result.filePath, printSize);

      res.status(201).json({
        captureId,
        filePath: result.filePath,
        width: result.width,
        height: result.height,
        printSize,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Composite failed", err);
      ctx.eventBus.emit({ type: "error", scope: "composite", message });
      res.status(400).json({ error: message });
    }
  }));

  router.post("/print", (req: Request, res: Response) => {
    const config = ctx.configStore.current;
    const parsed = PrintRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { captureId } = parsed.data;
    const size = parsed.data.size ?? config.printing.defaultSize;

    const row = ctx.outboxStore.getById(captureId);
    if (!row) {
      res.status(404).json({ error: `capture ${captureId} not found` });
      return;
    }
    if (!row.composite_path) {
      res.status(400).json({ error: `capture ${captureId} has not been composited yet` });
      return;
    }

    const job = ctx.printQueue.enqueue(captureId, size, row.composite_path);
    res.status(202).json(job);
  });

  router.get("/print/queue", (_req: Request, res: Response) => {
    res.json({ jobs: ctx.printQueue.getQueue() });
  });

  /**
   * Recent print jobs, newest first. After a media change this is how an
   * operator finds the jobs that were dropped into the hot folder while the
   * printer had no paper - those were recorded as 'dropped' (the agent's file
   * copy succeeded) but never physically printed, and the hot folder gives no
   * signal back to distinguish them.
   */
  router.get("/print/history", (req: Request, res: Response) => {
    const parsedLimit = Number(req.query["limit"] ?? 20);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 200)
      : 20;
    res.json({ jobs: ctx.outboxStore.getRecentPrintJobs(limit) });
  });

  router.post("/print/reprint", asyncHandler(async (req: Request, res: Response) => {
    const config = ctx.configStore.current;
    const parsed = ReprintRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { jobId, captureId, copies } = parsed.data;

    const original = jobId
      ? ctx.outboxStore.getPrintJobById(jobId)
      : ctx.outboxStore.getLatestPrintJobForCapture(captureId as string);

    if (!original) {
      res.status(404).json({
        error: jobId
          ? `print job ${jobId} not found`
          : `no previous print job for capture ${captureId}`,
      });
      return;
    }

    // The composite is written once and reused; a reprint hours later can
    // outlive a cleanup or a moved data dir, and enqueueing a job whose source
    // file is gone would fail silently on the background chain long after this
    // response returned 202. Fail here, where the operator is watching.
    try {
      await access(original.file_path);
    } catch {
      res.status(409).json({
        error: `composite file for this job is no longer on disk (${original.file_path}) - re-run /composite for capture ${original.capture_id}`,
      });
      return;
    }

    const size = parsed.data.size ?? (original.size as typeof config.printing.defaultSize);
    const jobs = [];
    for (let i = 0; i < copies; i += 1) {
      jobs.push(ctx.printQueue.enqueue(original.capture_id, size, original.file_path));
    }

    log.info(
      `Reprinting capture ${original.capture_id} (${copies} cop${copies === 1 ? "y" : "ies"}, ${size}) from job ${original.id}`
    );
    res.status(202).json({ captureId: original.capture_id, reprintedFrom: original.id, jobs });
  }));

  /**
   * Captures the sync worker has given up on. Abandonment is deliberately a
   * quiet state in /health (one warn line, one number) rather than a growing
   * error, so this is where the detail lives: which captures, and why.
   */
  router.get("/sync/abandoned", (_req: Request, res: Response) => {
    const rows = ctx.outboxStore.getAbandoned();
    res.json({
      count: rows.length,
      captures: rows.map((row) => ({
        captureId: row.id,
        eventId: row.event_id,
        takenAt: row.taken_at,
        expectedFile: row.composite_path ?? row.original_path,
        lastError: row.last_error,
        abandonedAt: row.sync_abandoned_at,
      })),
    });
  });

  /**
   * Puts every abandoned capture back in the queue. Abandonment must not be a
   * one-way door: the realistic cause is that the files were somewhere else
   * all along (a moved data dir, an unmounted drive), and once that is fixed
   * the rows are perfectly uploadable again.
   */
  router.post("/sync/abandoned/retry", (_req: Request, res: Response) => {
    const requeued = ctx.outboxStore.retryAbandoned();
    log.info(`Re-queued ${requeued} abandoned capture(s) for sync`);
    res.json({ requeued });
  });

  return router;
}

/**
 * aiOutputUrl is client-supplied (POST /composite) and is only ever supposed
 * to point at this project's own Supabase transform-image Edge Function
 * output - see the architecture note in README.md. Without an origin check,
 * a client with the shared secret could point the agent's fetch() at any
 * URL, including internal/loopback addresses it has no reason to reach -
 * this is what actually enforces "download, don't fetch arbitrary URLs".
 */
export function assertAllowedAiOutputOrigin(url: string, allowedOriginUrl: string): void {
  const origin = new URL(url).origin;
  const allowedOrigin = new URL(allowedOriginUrl).origin;
  if (origin !== allowedOrigin) {
    throw new Error(`aiOutputUrl must be hosted on ${allowedOrigin}, got ${origin}`);
  }
}

async function downloadAiOutput(url: string, destDir: string, allowedOriginUrl: string): Promise<string> {
  assertAllowedAiOutputOrigin(url, allowedOriginUrl);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download AI output (${response.status}): ${url}`);
  }
  await mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, `ai-${uuidv4()}.jpg`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
  return destPath;
}
