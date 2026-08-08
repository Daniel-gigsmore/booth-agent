import { ConfigStore } from "../config/config";
import { EventBus } from "../events/eventBus";
import { CameraManager } from "../camera/CameraManager";
import { OutboxStore } from "../outbox/outboxStore";
import { PrintQueue } from "../print/printQueue";

/** Everything the HTTP/WS layer needs, wired up once in index.ts. */
export interface AgentContext {
  configStore: ConfigStore;
  eventBus: EventBus;
  cameraManager: CameraManager;
  outboxStore: OutboxStore;
  printQueue: PrintQueue;
}
