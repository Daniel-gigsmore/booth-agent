import path from "node:path";
import { ConfigStore } from "./config/config";
import { EventBus } from "./events/eventBus";
import { CameraManager } from "./camera/CameraManager";
import { CanonTetheredSource } from "./camera/CanonTetheredSource";
import { EdsdkSource, spawnWorker } from "./camera/edsdk/EdsdkSource";
import { readSavedCameraSettings, migrateLegacyCameraSettings } from "./camera/cameraSettingsStore";
import { readCameraSerials, workerTarget } from "./camera/camerasStore";
import { WebcamSource } from "./camera/WebcamSource";
import { buildCameraSlots } from "./camera/cameraSlots";
import { createNikonSource } from "./camera/nikon/NikonSource";
import { CameraSlot } from "./events/types";
import { openOutboxDb } from "./outbox/db";
import { OutboxStore } from "./outbox/outboxStore";
import { SyncWorker } from "./outbox/syncWorker";
import { createSupabaseClient, uploadCaptureToSupabase } from "./supabase/supabaseClient";
import { AlbumPublisher } from "./album/albumPublisher";
import { createSupabaseAlbumBackend } from "./supabase/albumStorage";
import { PrintQueue } from "./print/printQueue";
import { printFileFor } from "./compositor/compositor";
import { buildHttpApp } from "./server/http";
import { attachEventsWebSocket } from "./server/ws";
import { AgentContext } from "./server/context";
import { EventStore } from "./session/eventStore";
import { readSessionSettings } from "./session/sessionSettings";
import { runPreflight, logPreflight } from "./startup/preflight";
import { createLogger } from "./util/logger";

const log = createLogger("index");

/**
 * A booth PC has nobody watching a console. Node's default for both of these
 * is to terminate the process, which mid-event means the queue stops, the
 * kiosk's WebSocket drops, and a guest is left standing there - over a fault
 * that may have had nothing to do with capturing or printing.
 *
 * The trade is real and worth stating: continuing past an uncaught exception
 * can leave in-memory state inconsistent. It is acceptable *here* because the
 * state that matters is not in memory - a capture is in SQLite and on disk
 * before /capture responds, and a print job is recorded before the file copy
 * starts - so the worst case is losing the one request that failed. Anything
 * that genuinely corrupts the process still gets restarted by node-windows.
 *
 * These are a backstop, not a substitute for handling errors at the source:
 * every route is wrapped in asyncHandler(), which is what should catch a
 * failing request. Anything arriving here is a bug, so it is logged at error.
 */
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection - continuing", reason);
});
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception - continuing", err);
});

async function main(): Promise<void> {
  const configPath = process.env["BOOTH_CONFIG_PATH"] ?? path.resolve(process.cwd(), "booth.config.json");
  const configStore = ConfigStore.load(configPath);
  configStore.watch();

  const eventBus = new EventBus();
  const config = configStore.current;

  // First start after the event-switching update: seed events.json from what the booth ran on until now.
  const events = EventStore.open(config.storage.dataDir, {
    id: config.event.id,
    name: config.event.name,
    albumToken: config.album.token,
    session: readSessionSettings(config.storage.dataDir),
  });

  // Before anything else touches hardware: verify the external dependencies
  // this agent cannot control (digiCamControl, Hot Folder Print, the printer,
  // disk, config placeholders). Deliberately non-blocking - a booth that
  // refuses to boot is worse than one that boots loudly broken, since the
  // operator can still run webcam-only or fix the printer while it serves
  // captures. The result is logged as a banner and served at
  // GET /health/preflight.
  const preflight = await runPreflight(config, events.active().id);
  logPreflight(preflight);

  // `driver` is read once at startup; switching it needs a service restart.
  const canonConfig = config.capture.canon;
  const dataDir = config.storage.dataDir;
  try {
    migrateLegacyCameraSettings(dataDir);
  } catch (err) {
    log.warn("Could not move camera.json to camera-high.json", err);
  }
  // Each slot's spawn re-reads cameras.json, so a Swap/Remember takes effect on the worker restart.
  const edsdkSlot = (slot: CameraSlot, alone: boolean) =>
    new EdsdkSource(
      () =>
        spawnWorker(
          canonConfig.edsdkDllPath,
          // The only Canon (the Nikon has the other slot): take whichever Canon body is plugged in.
          alone ? { serial: null, avoid: null, minBodies: 1 } : workerTarget(readCameraSerials(dataDir), slot)
        ),
      () => readSavedCameraSettings(dataDir, slot)
    );
  // `capture.nikon` is read once at startup too.
  const slots = buildCameraSlots(config.capture, {
    edsdk: edsdkSlot,
    digiCamControl: () => new CanonTetheredSource(canonConfig),
    nikon: (slot) => createNikonSource(config.capture.nikon.sdkDir, () => readSavedCameraSettings(dataDir, slot)),
  });
  const webcamSource = new WebcamSource(config.capture.webcam);
  const cameraManager = new CameraManager(
    { canon: slots.high, webcam: webcamSource, ...(slots.low ? { canonLow: slots.low } : {}) },
    config.capture.sourcePreference,
    eventBus
  );
  await cameraManager.start();

  const db = openOutboxDb(config.storage.dataDir, config.storage.outboxDbFileName);
  const outboxStore = new OutboxStore(db);

  const interruptedPrintJobs = outboxStore.resolveInterruptedPrintJobs();
  if (interruptedPrintJobs.length > 0) {
    log.warn(`Marked ${interruptedPrintJobs.length} print job(s) failed after an unclean shutdown`);
  }

  const supabaseClient = createSupabaseClient(config.supabase);
  const albumPublisher = new AlbumPublisher(
    {
      // Which photos: only the booth knows which composites were printed (not rejected at Review).
      listPrints: async (eventId) => outboxStore.listPublishedPrints(eventId),
      ...createSupabaseAlbumBackend(supabaseClient, () => configStore.current.supabase.storageBucket),
    },
    { activeId: () => events.active().id, tokenFor: (eventId) => events.get(eventId)?.albumToken }
  );
  const syncWorker = new SyncWorker(
    outboxStore,
    (row) => uploadCaptureToSupabase(supabaseClient, configStore.current.supabase, row),
    config.sync,
    eventBus,
    albumPublisher
  );
  syncWorker.start();

  const printQueue = new PrintQueue(
    config.printing.hotFolderPath,
    config.printing.secondsPerPrint,
    outboxStore,
    eventBus,
    // Composites are saved upright; the printer takes a portrait 4x6 sheet.
    (file) => printFileFor(file, configStore.current.compositing.jpegQuality)
  );

  const ctx: AgentContext = {
    configStore,
    eventBus,
    cameraManager,
    outboxStore,
    printQueue,
    album: albumPublisher,
    events,
    preflight,
  };

  // Reconcile the pieces that can change without a restart when booth.config.json is edited.
  configStore.onChange((next) => {
    cameraManager.setPreference(next.capture.sourcePreference);
  });

  const app = buildHttpApp(ctx);
  const httpServer = app.listen(config.agent.port, "127.0.0.1", () => {
    log.info(`booth-agent listening on http://127.0.0.1:${config.agent.port} (loopback only)`);
  });
  attachEventsWebSocket(httpServer, ctx);

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`Received ${signal}, shutting down`);
    httpServer.close();
    syncWorker.stop();
    await printQueue.stop();
    await cameraManager.stop();
    await configStore.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("Fatal startup error", err);
  process.exit(1);
});
