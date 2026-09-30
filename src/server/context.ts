import { ConfigStore } from "../config/config";
import { EventBus } from "../events/eventBus";
import { CameraManager } from "../camera/CameraManager";
import { OutboxStore } from "../outbox/outboxStore";
import { PrintQueue } from "../print/printQueue";
import { PreflightResult } from "../startup/preflight";
import { AlbumPublisher } from "../album/albumPublisher";
import { EventStore } from "../session/eventStore";

/** Everything the HTTP/WS layer needs, wired up once in index.ts. */
export interface AgentContext {
  configStore: ConfigStore;
  eventBus: EventBus;
  cameraManager: CameraManager;
  outboxStore: OutboxStore;
  printQueue: PrintQueue;
  /** The booth's events; captures, layouts and the album follow the active one. */
  events: EventStore;
  /** The event album's manifest writer; /health reports its status. */
  album: AlbumPublisher;
  /**
   * Most recent preflight result. Starts as the boot-time run and is replaced
   * by POST /health/preflight - the boot run is necessarily pessimistic about
   * anything that starts after this service does (HFP, the printer).
   */
  preflight: PreflightResult;
}
