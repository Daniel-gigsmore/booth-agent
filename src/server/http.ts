import express, { Express, NextFunction, Request, Response } from "express";
import { AgentContext } from "./context";
import { sharedSecretAuth } from "./auth";
import { buildRouter } from "./routes";
import { createLogger } from "../util/logger";

const log = createLogger("server:http");

export function buildHttpApp(ctx: AgentContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "5mb" }));
  app.use(sharedSecretAuth(() => ctx.configStore.current.agent.sharedSecret));
  app.use(buildRouter(ctx));

  // Central error handler: never let an unhandled route error take the process down.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Unhandled request error", err);
    res.status(500).json({ error: message });
  });

  return app;
}
