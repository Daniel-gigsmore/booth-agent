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

  // Central error handler: never let an unhandled route error take the process
  // down. Reached from async handlers only because they are wrapped in
  // asyncHandler() - Express 4 does not forward a rejected promise on its own.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Unhandled request error", err);
    // /liveview streams its response, so by the time it can fail the status
    // line is long gone and writing a JSON body would throw a second error on
    // top of the first. Express's own final handler knows how to close a
    // response in that state.
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: message });
  });

  return app;
}
