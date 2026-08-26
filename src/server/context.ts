import { ConfigStore } from "../config/config";
import { EventBus } from "../events/eventBus";
import { CameraManager } from "../camera/CameraManager";
import { OutboxStore } from "../outbox/outboxStore";
import { PrintQueue } from "../print/printQueue";
import { PreflightResult } from "../startup/preflight";

/** Everything the HTTP/WS layer needs, wired up once in index.ts. */
export interface AgentContext {
  configStore: ConfigStore;
  eventBus: EventBus;
  cameraManager: CameraManager;
  outboxStore: OutboxStore;
  printQueue: PrintQueue;
  /** Result of the boot-time preflight, exposed at GET /health/preflight. */
  preflight: PreflightResult;
}
