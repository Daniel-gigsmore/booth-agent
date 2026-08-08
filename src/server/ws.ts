import { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "node:url";
import { AgentContext } from "./context";
import { createLogger } from "../util/logger";

const log = createLogger("server:ws");

/** Attaches the /events WebSocket endpoint to an existing HTTP server. */
export function attachEventsWebSocket(httpServer: HttpServer, ctx: AgentContext): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    if (url.pathname !== "/events") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? undefined;
    if (token !== ctx.configStore.current.agent.sharedSecret) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    log.info("Client connected to /events");
    const unsubscribe = ctx.eventBus.subscribe((event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });
    ws.on("close", () => {
      unsubscribe();
    });
    ws.on("error", (err) => {
      log.debug("WS client error", err);
    });
  });

  return wss;
}
