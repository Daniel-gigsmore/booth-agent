import { Router, Request, Response } from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { AgentContext } from "./context";
import { PrintSizeSchema } from "../config/schema";
import { loadTemplate, resolveOverlayPath } from "../compositor/template";
import { renderComposite } from "../compositor/compositor";
import { originalsDir, compositesDir, aiDownloadsDir } from "../util/paths";
import { isHotFolderWritable } from "../print/hotFolder";
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

export function buildRouter(ctx: AgentContext): Router {
  const router = Router();

  router.get("/health", async (_req: Request, res: Response) => {
    const config = ctx.configStore.current;
    const cameraStatus = ctx.cameraManager.getStatus();
    const [hotFolderWritable, diskSpace] = await Promise.all([
      isHotFolderWritable(config.printing.hotFolderPath),
      getDiskSpace(config.storage.dataDir),
    ]);
    const syncSummary = ctx.outboxStore.getSyncSummary();

    res.json({
      camera: {
        activeSource: cameraStatus.activeSource,
        model: cameraStatus.activeModel,
        canonConnected: cameraStatus.canonConnected,
        webcamConnected: cameraStatus.webcamConnected,
        preference: cameraStatus.preference,
      },
      hotFolder: {
        path: config.printing.hotFolderPath,
        writable: hotFolderWritable,
      },
      disk: diskSpace,
      outbox: {
        queueDepth: syncSummary.queueDepth,
        lastSyncAt: syncSummary.lastSyncAt,
        lastError: syncSummary.lastError,
      },
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/liveview", async (req: Request, res: Response) => {
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

    while (!closed) {
      const result = await ctx.cameraManager.getLiveviewFrame();
      if (result) {
        const header =
          `--${boundary}\r\n` +
          `Content-Type: image/jpeg\r\n` +
          `Content-Length: ${result.frame.length}\r\n\r\n`;
        res.write(header);
        res.write(result.frame);
        res.write("\r\n");
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    res.end();
  });

  router.post("/capture", async (_req: Request, res: Response) => {
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
  });

  router.post("/composite", async (req: Request, res: Response) => {
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
        ? await downloadAiOutput(aiOutputUrl, aiDownloadsDir(config))
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
  });

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

  return router;
}

async function downloadAiOutput(url: string, destDir: string): Promise<string> {
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
