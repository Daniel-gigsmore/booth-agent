import { EventEmitter } from "node:events";
import { BoothEvent } from "./types";

/**
 * Single process-wide bus. Every domain module (camera manager, outbox sync,
 * print queue) emits onto this; the WS server is just one more subscriber.
 * Keeping it decoupled from the WS layer means unit tests can assert on
 * emitted events without spinning up a socket server.
 */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(event: BoothEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: BoothEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
