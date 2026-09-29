import express, { Express, NextFunction, Request, Response } from "express";
import path from "node:path";
import { AgentContext } from "./context";
import { sharedSecretAuth } from "./auth";
import { corsMiddleware } from "./cors";
import { buildRouter } from "./routes";
import { createLogger } from "../util/logger";

const log = createLogger("server:http");

/** The album page's files (repo download/), from both src/server and dist/server. */
const DOWNLOAD_DIR = path.resolve(__dirname, "..", "..", "download");

export function buildHttpApp(ctx: AgentContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(corsMiddleware(() => ctx.configStore.current.agent.allowedOrigins));
  // Layout files carry their images as base64 and can be far bigger than any
  // other request. /layout-import parses its own body (after auth) with a
  // larger limit, so the small global parser skips it.
  const json = express.json({ limit: "5mb" });
  app.use((req, res, next) => (req.path === "/layout-import" ? next() : json(req, res, next)));
  // The album page's own files, so a screen cabled to the booth can show the album with no
  // internet. Page code only, no data: /album.json and the photos it loads still need the secret.
  // Anything else under /album (a missing file, a path escaping the folder) is a plain 404 here,
  // rather than a 401 from auth below or a 500 from the error handler.
  app.use("/album", express.static(DOWNLOAD_DIR, { index: false }));
  app.use("/album", (_req: Request, res: Response) => {
    res.status(404).json({ error: "not found" });
  });
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
