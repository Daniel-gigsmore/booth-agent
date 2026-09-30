import express, { Router, Request, Response } from "express";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { AgentContext } from "./context";
import { asyncHandler } from "./asyncHandler";
import { writeBackpressureAware } from "./streamWrite";
import { PrintSizeSchema } from "../config/schema";
import { CameraUnavailableError } from "../camera/CameraSource";
import { readSavedCameraSettings, saveCameraSettings, clearSavedCameraSettings, SettingChangesSchema } from "../camera/cameraSettingsStore";
import { readCameraSerials, writeCameraSerials, CameraSerials } from "../camera/camerasStore";
import { CameraSlot } from "../events/types";
import { SettingKey, SettingChanges } from "../camera/edsdk/protocol";
import {
  loadTemplate,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  saveAsset,
  assetPath,
  shotCount,
  validateTemplate,
  assertImagesAllowed,
  usesCamera,
} from "../compositor/template";
import { exportLayout, importLayout, copyLayout } from "../compositor/templateTransfer";
import { FONTS, fontFilePath } from "../compositor/fonts";
import { textVariables } from "../compositor/variables";
import { SessionSettingsSchema } from "../session/sessionSettings";
import { NewEventSchema, UnknownEventError, BoothEvent } from "../session/eventStore";
import { renderComposite, renderSheet } from "../compositor/compositor";
import { samplePhotos } from "../compositor/samples";
import { originalsDir, compositesDir, aiDownloadsDir, samplesDir } from "../util/paths";
import { isHotFolderWritable, dropIntoHotFolder } from "../print/hotFolder";
import { isDigiCamControlRunning } from "../camera/CanonTetheredSource";
import { readPrinterStatus, defaultPrinterStatusPath } from "../print/printerStatus";
import { reconcileHotFolderDrops } from "../print/hotFolderStall";
import { buildHealthReport } from "../health/healthReport";
import { runPreflight, logPreflight } from "../startup/preflight";
import { getDiskSpace } from "../util/disk";
import { createLogger } from "../util/logger";

const log = createLogger("server:routes");

// tasklist is a process spawn and the kiosk polls /health every few seconds;
// whether digiCamControl is running doesn't change that fast.
const DIGICAM_CHECK_TTL_MS = 10_000;
let digiCamCheck: { at: number; running: Promise<boolean> } | null = null;
function digiCamControlRunningCached(): Promise<boolean> {
  if (!digiCamCheck || Date.now() - digiCamCheck.at >= DIGICAM_CHECK_TTL_MS) {
    digiCamCheck = { at: Date.now(), running: isDigiCamControlRunning().catch(() => false) };
  }
  return digiCamCheck.running;
}

const CameraBodySchema = z.object({ camera: z.enum(["high", "low"]).default("high") });
/** ?camera=high|low, high when absent. Anything else answers 400 and returns null: the caller just returns. */
function slotParam(req: Request, res: Response): CameraSlot | null {
  const camera = req.query["camera"];
  if (camera === undefined || camera === "high" || camera === "low") return camera ?? "high";
  res.status(400).json({ error: 'camera must be "high" or "low"' });
  return null;
}

const CompositeRequestSchema = z.object({
  captureId: z.string().min(1),
  /**
   * Every shot of a multi-photo session, in slot order. The first must be
   * captureId, which is the capture the composite (and so its print jobs and
   * sync) is filed under. Omitted = captureId alone fills every slot.
   */
  captureIds: z.array(z.string().min(1)).min(1).max(12).optional(),
  templateId: z.string().min(1),
  printSize: PrintSizeSchema.optional(),
  aiOutputUrl: z.string().url().optional(),
});

const PrintRequestSchema = z.object({
  captureId: z.string().min(1),
  size: PrintSizeSchema.optional(),
  copies: z.number().int().min(1).max(5).default(1),
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
    const event = ctx.events.active();
    const cameraStatus = ctx.cameraManager.getStatus();
    const [hotFolderWritable, diskSpace, printerStatus, stalledPrints, digiCamControlRunning] = await Promise.all([
      isHotFolderWritable(config.printing.hotFolderPath),
      getDiskSpace(config.storage.dataDir),
      readPrinterStatus({
        statusFilePath:
          config.printing.printerStatusPath ??
          defaultPrinterStatusPath(config.printing.hotFolderPath),
        staleAfterMs: config.printing.printerStatusStaleMs,
      }),
      reconcileHotFolderDrops(ctx.outboxStore, config.printing.hotFolderStallSeconds),
      config.capture.canon.driver === "edsdk" ? digiCamControlRunningCached() : Promise.resolve(false),
    ]);

    // Whether a missing low camera affects guests right now. A layout that won't
    // load is reported by /session; here it just counts as "not using it".
    // Without a low slot (digiCamControl) there is nothing to ask, so no template load.
    let layoutUsesLow = false;
    if (cameraStatus.low) {
      try {
        layoutUsesLow = usesCamera(
          loadTemplate(config.compositing.templateDir, event.session.templateId),
          "low"
        );
      } catch {
        /* see /session */
      }
    }

    res.json(
      buildHealthReport({
        camera: cameraStatus,
        canon: { driver: config.capture.canon.driver, digiCamControlRunning },
        hotFolder: {
          path: config.printing.hotFolderPath,
          writable: hotFolderWritable,
        },
        stalledPrints,
        printer: printerStatus,
        disk: diskSpace,
        outbox: ctx.outboxStore.getSyncSummary(),
        eventId: event.id,
        eventName: event.name,
        eventDate: event.date,
        eventsFileError: ctx.events.loadError,
        thresholds: {
          lowDiskWarnBytes: config.storage.lowDiskWarnBytes,
          lowMediaWarnPrints: config.printing.lowMediaWarnPrints,
          outboxBacklogWarn: config.sync.backlogWarnCount,
          expectedMediaType: config.printing.expectedMediaType,
        },
        layoutUsesLow,
        album: ctx.album.getStatus(),
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
    const result = await runPreflight(ctx.configStore.current, ctx.events.active().id);
    logPreflight(result);
    ctx.preflight = result;
    res.json(result);
  }));

  router.get("/liveview", asyncHandler(async (req: Request, res: Response) => {
    const camera = slotParam(req, res);
    if (!camera) return;
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
        const result = await ctx.cameraManager.getLiveviewFrame(camera);
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

  router.post("/capture", asyncHandler(async (req: Request, res: Response) => {
    const config = ctx.configStore.current;
    const parsed = CameraBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'camera must be "high" or "low"' });
      return;
    }
    try {
      const captureId = uuidv4();
      const result = await ctx.cameraManager.capture(originalsDir(config), parsed.data.camera);
      const takenAt = new Date().toISOString();

      ctx.outboxStore.insertCapture({
        id: captureId,
        eventId: ctx.events.active().id,
        source: result.source,
        camera: result.camera,
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
        camera: result.camera,
        takenAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Capture failed", err);
      ctx.eventBus.emit({ type: "error", scope: "capture", message });
      res.status(503).json({ error: message });
    }
  }));

  // The kiosk calls this ~1.5 s before each shot so autofocus is done by the
  // time /capture arrives. Fire-and-forget: the answer never waits on the camera.
  router.post("/camera/prefocus", (req: Request, res: Response) => {
    // prefocus() never rejects, but a floating promise must not become an
    // unhandled rejection if that ever changes (or a test double rejects).
    const parsed = CameraBodySchema.safeParse(req.body ?? {});
    ctx.cameraManager.prefocus(parsed.success ? parsed.data.camera : "high").catch(() => undefined);
    res.status(202).json({});
  });

  // --- Camera settings (operator panel) ---------------------------------
  const cameraError = (res: Response, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(err instanceof CameraUnavailableError ? 409 : 500).json({ error: message });
  };

  router.get("/camera/settings", asyncHandler(async (req: Request, res: Response) => {
    const slot = slotParam(req, res);
    if (!slot) return;
    try {
      const settings = await ctx.cameraManager.getCanonSettings(slot);
      res.json({ ...settings, saved: readSavedCameraSettings(ctx.configStore.current.storage.dataDir, slot) });
    } catch (err) {
      cameraError(res, err);
    }
  }));

  router.post("/camera/settings", asyncHandler(async (req: Request, res: Response) => {
    const slot = slotParam(req, res);
    if (!slot) return;
    const parsed = SettingChangesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "expected { iso?, av?, tv?, wb?, ev?, quality? } as EDSDK codes" });
      return;
    }
    try {
      // See cameraSettingsStore.ts: zod's `.partial()` output is stricter than SettingChanges
      // needs to be under exactOptionalPropertyTypes.
      const settings = await ctx.cameraManager.setCanonSettings(parsed.data as SettingChanges, slot);
      // Save only what the camera took, so a reconnect doesn't keep retrying a value it refuses.
      const accepted = Object.fromEntries(
        Object.entries(parsed.data).filter(([key]) => !settings.rejected.includes(key as SettingKey))
      );
      const saved = saveCameraSettings(ctx.configStore.current.storage.dataDir, slot, accepted);
      res.json({ ...settings, saved });
    } catch (err) {
      cameraError(res, err);
    }
  }));

  router.post("/camera/settings/reset", (req: Request, res: Response) => {
    const slot = slotParam(req, res);
    if (!slot) return;
    clearSavedCameraSettings(ctx.configStore.current.storage.dataDir, slot);
    res.json({ saved: {} });
  });

  // A photo for the operator to judge the settings by: never a capture row,
  // never printed, never synced, and deleted once sent.
  router.post("/camera/test-shot", asyncHandler(async (req: Request, res: Response) => {
    const slot = slotParam(req, res);
    if (!slot) return;
    let file: string | null = null;
    try {
      const shot = await ctx.cameraManager.captureExact(path.join(ctx.configStore.current.storage.dataDir, "test-shots"), slot);
      file = shot.filePath;
      res.setHeader("X-Capture-Source", shot.source);
      res.type("image/jpeg").send(await readFile(file));
    } catch (err) {
      res.status(err instanceof CameraUnavailableError ? 409 : 503).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (file) await unlink(file).catch(() => undefined);
    }
  }));

  // --- Camera pairing (which body is high, which low) --------------------
  router.get("/cameras", (_req: Request, res: Response) => {
    const s = ctx.cameraManager.getStatus();
    const saved = readCameraSerials(ctx.configStore.current.storage.dataDir);
    res.json({
      slots: {
        high: { connected: s.canonConnected, model: s.canonModel, serial: s.canonSerial, remembered: saved.high ?? null },
        low: { connected: s.low?.connected ?? false, model: s.low?.model ?? null, serial: s.low?.serial ?? null, remembered: saved.low ?? null },
      },
    });
  });

  /** Saves `serials` (dropping empty slots) and re-opens both cameras with them. */
  const pair = (res: Response, serials: Partial<Record<CameraSlot, string | null | undefined>>) => {
    const next: CameraSerials = {};
    if (serials.high) next.high = serials.high;
    if (serials.low) next.low = serials.low;
    if (!next.high && !next.low) {
      res.status(409).json({ error: "No camera to pair - connect the cameras first" });
      return;
    }
    writeCameraSerials(ctx.configStore.current.storage.dataDir, next);
    ctx.cameraManager.restartCanonWorkers();
    res.json({ saved: next });
  };

  router.post("/cameras/remember", (_req: Request, res: Response) => {
    const s = ctx.cameraManager.getStatus();
    const saved = readCameraSerials(ctx.configStore.current.storage.dataDir);
    pair(res, { high: s.canonSerial ?? saved.high, low: s.low?.serial ?? saved.low });
  });

  router.post("/cameras/swap", (_req: Request, res: Response) => {
    const s = ctx.cameraManager.getStatus();
    const saved = readCameraSerials(ctx.configStore.current.storage.dataDir);
    pair(res, { high: saved.low ?? s.low?.serial, low: saved.high ?? s.canonSerial });
  });

  // The album on a screen cabled to the booth: the same shape as the manifest the agent writes to
  // Supabase, built from the outbox so it works with no internet. Photos come from
  // /captures/:id/image?variant=composite.
  router.get("/album.json", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store").json({
      updatedAt: new Date().toISOString(),
      photos: ctx.outboxStore.listAlbumPrints(ctx.events.active().id),
    });
  });

  // What the kiosk's operator Album tab needs to build the online album link and QR, and the
  // attract screen's slideshow switch. The token stays behind the secret: it is not in /health,
  // which phones on the venue wifi read. Not under /album/, which is served without the secret.
  router.get("/album-info", (_req: Request, res: Response) => {
    const event = ctx.events.active();
    res.set("Cache-Control", "no-store").json({
      token: event.albumToken ?? null,
      eventId: event.id,
      eventName: event.name,
      attractSlideshow: event.session.attractSlideshow,
    });
  });

  // Its own route rather than POST /session, which needs a layout that loads.
  router.post("/attract-slideshow", (req: Request, res: Response) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "enabled must be true or false" });
      return;
    }
    ctx.events.updateActiveSession({ ...ctx.events.active().session, attractSlideshow: parsed.data.enabled });
    log.info(`Attract slideshow ${parsed.data.enabled ? "on" : "off"}`);
    res.json({ attractSlideshow: parsed.data.enabled });
  });

  // The kiosk's review screen shows the still the guest just took. /capture
  // only hands back a local path the browser cannot open, so serve the file
  // here. The path comes from the outbox row, never from the request, so the
  // id cannot be turned into a read of anything else on disk.
  // ?variant=composite serves the print-ready composite instead, so the
  // kiosk can show the guest exactly what will come out of the printer.
  router.get("/captures/:id/image", (req: Request<{ id: string }>, res: Response) => {
    const { id } = req.params;
    const row = ctx.outboxStore.getById(id);
    if (!row) {
      res.status(404).json({ error: `capture ${id} not found` });
      return;
    }
    const file = req.query["variant"] === "composite" ? row.composite_path : row.original_path;
    if (!file) {
      res.status(404).json({ error: `capture ${id} has not been composited yet` });
      return;
    }
    res.sendFile(path.resolve(file), (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: `capture ${id} file is missing` });
      }
    });
  });

  router.post("/composite",asyncHandler(async (req: Request, res: Response) => {
    const config = ctx.configStore.current;
    const parsed = CompositeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { captureId, templateId, aiOutputUrl } = parsed.data;
    const captureIds = parsed.data.captureIds ?? [captureId];
    if (captureIds[0] !== captureId) {
      res.status(400).json({ error: "captureIds must start with captureId" });
      return;
    }

    const rows = captureIds.map((id) => ctx.outboxStore.getById(id));
    const missing = captureIds.filter((_, i) => !rows[i]);
    if (missing.length > 0) {
      res.status(404).json({ error: `capture ${missing.join(", ")} not found` });
      return;
    }

    try {
      const sourceImagePaths = aiOutputUrl
        ? [await downloadAiOutput(aiOutputUrl, aiDownloadsDir(config), config.supabase.url)]
        : rows.map((row) => row!.original_path);

      const template = loadTemplate(config.compositing.templateDir, templateId);
      // The template knows what paper it was drawn for; defaulting to the
      // config's size instead made every strip template fail unless the
      // client repeated the size it had already implied by choosing it.
      const printSize = parsed.data.printSize ?? template.printSize;

      const result = await renderComposite({
        sourceImagePaths,
        template,
        assetDir: config.compositing.templateDir,
        variables: textVariables(ctx.events.active().name, captureId),
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
    const { captureId, copies } = parsed.data;
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

    const jobs = [];
    for (let i = 0; i < copies; i += 1) {
      jobs.push(ctx.printQueue.enqueue(captureId, size, row.composite_path));
    }
    // The online album lists printed photos only; its composite may already have uploaded.
    ctx.album.markDirty(row.event_id);

    // Keep the single-job response shape for the common copies=1 case so
    // existing callers (kiosk UI) reading `jobId`/`queuePosition` directly
    // off the body don't break; only multi-copy requests get the `jobs` array,
    // matching /print/reprint's shape for the same multi-copy case.
    if (copies === 1) {
      res.status(202).json(jobs[0]);
    } else {
      res.status(202).json({ captureId, jobs });
    }
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

  // --- Layouts and session settings -----------------------------------------
  // The kiosk's operator panel edits these on the touchscreen during an event.
  // Everything is POST (no PUT/DELETE) so the CORS preflight allowlist in
  // cors.ts stays GET/POST only.

  router.get("/templates", (_req: Request, res: Response) => {
    const dir = ctx.configStore.current.compositing.templateDir;
    res.json({ templates: listTemplates(dir) });
  });

  /** A draft layout (saved or not) rendered with sample photos, exactly as it would print. */
  async function renderDraft(body: unknown) {
    const config = ctx.configStore.current;
    const dir = config.compositing.templateDir;
    const template = validateTemplate(body);
    assertImagesAllowed(dir, template);
    const jpeg = await renderSheet({
      sourceImagePaths: await samplePhotos(samplesDir(config), shotCount(template)),
      template,
      assetDir: dir,
      variables: textVariables(ctx.events.active().name, "a1b2c3d4"),
      printSize: template.printSize,
      jpegQuality: config.compositing.jpegQuality,
    });
    return { template, jpeg };
  }

  router.post("/layout-preview", asyncHandler(async (req: Request, res: Response) => {
    try {
      const { jpeg } = await renderDraft(req.body);
      res.type("image/jpeg").send(jpeg);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }));

  // One sheet of paper for the operator: the preview, straight into the hot
  // folder. No capture or print-job row is made, so nothing syncs to Supabase
  // and the guest print history stays clean.
  router.post("/layout-preview/print", asyncHandler(async (req: Request, res: Response) => {
    const config = ctx.configStore.current;
    let file: string | null = null;
    try {
      const { template, jpeg } = await renderDraft(req.body);
      const dir = compositesDir(config);
      await mkdir(dir, { recursive: true });
      const jobId = `test-${uuidv4()}`;
      file = path.join(dir, `${jobId}.jpg`);
      await writeFile(file, jpeg);
      await dropIntoHotFolder(config.printing.hotFolderPath, template.printSize, jobId, file);
      log.info(`Test print of layout ${template.id} dropped into the hot folder (${jobId})`);
      res.status(202).json({ jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      // The hot folder has its own copy; nothing else uses the source, so
      // don't leave test-print JPEGs accumulating under composites/. A
      // missing file (e.g. the drop never got this far) must never turn
      // the response into an error.
      if (file) await unlink(file).catch(() => {});
    }
  }));

  router.get("/templates/:id/export", asyncHandler(async (req: Request, res: Response) => {
    const dir = ctx.configStore.current.compositing.templateDir;
    try {
      res.json(await exportLayout(dir, String(req.params["id"])));
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }));

  router.post(
    "/layout-import",
    express.json({ limit: "60mb" }),
    asyncHandler(async (req: Request, res: Response) => {
      const dir = ctx.configStore.current.compositing.templateDir;
      try {
        const template = await importLayout(dir, req.body);
        log.info(`Imported layout ${template.id}`);
        res.status(201).json(template);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })
  );

  const CopyRequestSchema = z.object({ name: z.string().trim().min(1).max(80), template: z.unknown() });

  router.post("/templates/:id/copy", asyncHandler(async (req: Request, res: Response) => {
    const dir = ctx.configStore.current.compositing.templateDir;
    const parsed = CopyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "give the new layout a name" });
      return;
    }
    try {
      const template = await copyLayout(dir, String(req.params["id"]), parsed.data.template, parsed.data.name);
      log.info(`Saved layout ${req.params["id"]} as new layout ${template.id}`);
      res.status(201).json(template);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }));

  router.post("/templates/:id", (req: Request<{ id: string }>, res: Response) => {
    const dir = ctx.configStore.current.compositing.templateDir;
    try {
      const template = saveTemplate(dir, { ...req.body, id: req.params.id });
      log.info(`Saved layout ${template.id} (${shotCount(template)} photos, ${template.elements.length} elements)`);
      res.json(template);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/templates/:id/delete", (req: Request<{ id: string }>, res: Response) => {
    const config = ctx.configStore.current;
    const { id } = req.params;
    if (ctx.events.active().session.templateId === id) {
      res.status(409).json({ error: `layout ${id} is in use - pick another layout in Settings first` });
      return;
    }
    try {
      deleteTemplate(config.compositing.templateDir, id);
      res.json({ deleted: id });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Images a layout draws (logos, frames, stickers). The agent names the file;
  // the layout then refers to it from an image element.
  router.post(
    "/templates/:id/assets",
    express.raw({ type: ["image/png", "image/jpeg"], limit: "10mb" }),
    asyncHandler(async (req: Request, res: Response) => {
      const dir = ctx.configStore.current.compositing.templateDir;
      try {
        res.status(201).json({ file: await saveAsset(dir, String(req.params["id"]), req.body) });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })
  );

  router.get("/templates/:id/assets/:file", (req: Request<{ id: string; file: string }>, res: Response) => {
    const dir = ctx.configStore.current.compositing.templateDir;
    try {
      res.sendFile(path.resolve(assetPath(dir, req.params.id, req.params.file)), (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "image file is missing" });
      });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Fonts text elements can use; the kiosk editor loads the same files.
  router.get("/fonts", (_req: Request, res: Response) => {
    res.json({ fonts: FONTS });
  });

  router.get("/fonts/:file", (req: Request<{ file: string }>, res: Response) => {
    const file = fontFilePath(req.params.file);
    if (!file) {
      res.status(404).json({ error: "no such font" });
      return;
    }
    res.sendFile(file);
  });

  /** Settings plus the layout they point at, so the kiosk knows how many shots to take. */
  router.get("/session", (_req: Request, res: Response) => {
    const config = ctx.configStore.current;
    const settings = ctx.events.active().session;
    try {
      res.json({
        ...settings,
        template: loadTemplate(config.compositing.templateDir, settings.templateId),
      });
    } catch (err) {
      res.status(409).json({
        ...settings,
        template: null,
        error: `layout ${settings.templateId} can't be loaded - pick another in Settings (${
          err instanceof Error ? err.message : String(err)
        })`,
      });
    }
  });

  router.post("/session", (req: Request, res: Response) => {
    const config = ctx.configStore.current;
    // A body without attractSlideshow (an older kiosk, or Settings when GET /session failed) keeps what is set.
    const current = ctx.events.active().session;
    const parsed = SessionSettingsSchema.safeParse({ attractSlideshow: current.attractSlideshow, ...req.body });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const template = loadTemplate(config.compositing.templateDir, parsed.data.templateId);
      ctx.events.updateActiveSession(parsed.data);
      log.info(`Session settings changed: ${JSON.stringify(parsed.data)}`);
      res.json({ ...parsed.data, template });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The operator panel's Events tab. Switching changes where the next capture goes, so it is
  // only offered there, never mid-session.
  const eventSummary = (e: BoothEvent) => ({ id: e.id, name: e.name, date: e.date });

  router.get("/events", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store").json({
      activeId: ctx.events.active().id,
      events: ctx.events.list().map((e) => ({ ...eventSummary(e), photoCount: ctx.outboxStore.listAlbumPrints(e.id).length })),
    });
  });

  router.post("/events", (req: Request, res: Response) => {
    const parsed = NewEventSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      return;
    }
    try {
      const event = ctx.events.create(parsed.data as { name: string; date?: string });
      log.info(`New event "${event.name}" (${event.id}) is now active`);
      res.status(201).json(eventSummary(event));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/events/:id/activate", (req: Request<{ id: string }>, res: Response) => {
    try {
      const event = ctx.events.activate(req.params.id);
      // Catches up anything that changed while another event was on.
      ctx.album.markDirty(event.id);
      log.info(`Switched to event "${event.name}" (${event.id})`);
      res.json(eventSummary(event));
    } catch (err) {
      const status = err instanceof UnknownEventError ? 404 : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
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
