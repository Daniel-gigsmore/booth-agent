import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Without this, a browser kiosk UI cannot call the agent at all.
 *
 * Every route sits behind sharedSecretAuth, and a browser sends a CORS
 * preflight (`OPTIONS`) the moment a cross-origin request carries an
 * `Authorization` header - which every call from the kiosk does. That
 * preflight deliberately carries no credentials of its own, so it reaches the
 * auth middleware, gets 401, and the browser never sends the real request.
 *
 * The failure is misleading in the worst possible way. Devtools reports a CORS
 * error, which reads as "the agent is down" while the agent is healthy and
 * answering. Meanwhile `<img src="/liveview?token=">` keeps streaming
 * perfectly, because images aren't subject to CORS - so the booth looks half
 * alive and the obvious suspects (port, service, firewall) all check out.
 *
 * Mount this BEFORE sharedSecretAuth so preflights are answered before auth
 * ever runs. It is not an auth layer and doesn't try to be one: the shared
 * secret still guards every real request, and a non-browser client (curl,
 * PowerShell, the WebSocket upgrade) is unaffected because it sends no Origin.
 * CORS only tells a browser which pages may read the response.
 */
export function corsMiddleware(getAllowedOrigins: () => readonly string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Set even when the origin is rejected: the same URL yields a response with
    // or without Access-Control-Allow-Origin depending on the request's Origin,
    // so anything caching in between must key on it.
    res.setHeader("Vary", "Origin");

    const origin = req.headers.origin;
    const isAllowed = typeof origin === "string" && getAllowedOrigins().includes(origin);
    if (isAllowed) {
      // Echo the exact origin rather than "*". Not for security - the secret
      // does that - but because "*" is incompatible with credentialed requests,
      // so echoing keeps the door open if the kiosk ever needs cookies.
      res.setHeader("Access-Control-Allow-Origin", origin);
    }

    // A real preflight always carries Origin. An OPTIONS without one isn't a
    // preflight, so let it fall through and be treated like any other request.
    if (req.method !== "OPTIONS" || origin === undefined) {
      next();
      return;
    }

    if (!isAllowed) {
      // The browser blocks the real request either way once the approval header
      // is missing, so this status is only ever read by whoever is debugging.
      // 403 puts a line in the agent's log saying "an origin asked and wasn't on
      // the list" - the single most useful clue when the kiosk's origin hasn't
      // been added to allowedOrigins yet.
      res.sendStatus(403);
      return;
    }

    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    // Named explicitly rather than reflected back from
    // Access-Control-Request-Headers: these two are all the kiosk needs, and
    // reflecting whatever was asked for approves headers nobody has considered.
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    // Preflights are cached per (origin, path, method), and the kiosk hits
    // /capture, /composite and /print repeatedly for every guest. Ten minutes
    // keeps the extra round trip off the shutter path without pinning a stale
    // allowlist for long after an operator edits the config.
    res.setHeader("Access-Control-Max-Age", "600");
    res.sendStatus(204);
  };
}
