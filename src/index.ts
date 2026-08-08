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
import { createLogger } from "./util/logger";

const log = createLogger("index");

async function main(): Promise<void> {
  const configPath = process.env["BOOTH_CONFIG_PATH"] ?? path.resolve(process.cwd(), "booth.config.json");
  const configStore = ConfigStore.load(configPath);
  configStore.watch();

  const eventBus = new EventBus();
  const config = configStore.current;

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
