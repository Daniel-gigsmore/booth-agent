import path from "node:path";
import { ConfigStore } from "./config/config";
import { EventBus } from "./events/eventBus";
import { CameraManager } from "./camera/CameraManager";
import { CanonTetheredSource } from "./camera/CanonTetheredSource";
import { WebcamSource } from "./camera/WebcamSource";
import { openOutboxDb } from "./outbox/db";
import { OutboxStore } from "./outbox/outboxStore";
import { SyncWorker } from "./outbox/syncWorker";
import { createSupabaseClient, uploadCaptureToSupabase } from "./supabase/supabaseClient";
import { PrintQueue } from "./print/printQueue";
import { buildHttpApp } from "./server/http";
import { attachEventsWebSocket } from "./server/ws";
import { AgentContext } from "./server/context";
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

  // Before anything else touches hardware: verify the external dependencies
  // this agent cannot control (digiCamControl, Hot Folder Print, the printer,
  // disk, config placeholders). Deliberately non-blocking - a booth that
  // refuses to boot is worse than one that boots loudly broken, since the
  // operator can still run webcam-only or fix the printer while it serves
  // captures. The result is logged as a banner and served at
  // GET /health/preflight.
  const preflight = await runPreflight(config);
  logPreflight(preflight);

  const canonSource = new CanonTetheredSource(config.capture.canon);
  const webcamSource = new WebcamSource(config.capture.webcam);
  const cameraManager = new CameraManager(
    { canon: canonSource, webcam: webcamSource },
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
  const syncWorker = new SyncWorker(
    outboxStore,
    (row) => uploadCaptureToSupabase(supabaseClient, configStore.current.supabase, row),
    config.sync,
    eventBus
  );
  syncWorker.start();

  const printQueue = new PrintQueue(
    config.printing.hotFolderPath,
    config.printing.secondsPerPrint,
    outboxStore,
    eventBus
  );

  const ctx: AgentContext = {
    configStore,
    eventBus,
    cameraManager,
    outboxStore,
    printQueue,
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
