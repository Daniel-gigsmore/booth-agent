import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 ignores whatever an `async` route handler returns, so a rejected
 * promise inside one never reaches `next()`, never reaches the app's error
 * handler in http.ts, and surfaces as an unhandled rejection instead - which
 * Node has terminated the process over by default since v15.
 *
 * For this agent that means a single failed `/health` read could take the
 * whole booth down mid-event, with the camera and print paths working
 * perfectly. Wrapping every async handler in this routes the rejection back
 * into Express, where it becomes a 500 for that one request and nothing else.
 *
 * The alternative is Express 5, which forwards rejections natively; this is
 * the smaller change and doesn't move the whole middleware stack onto a new
 * major version days before an event.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
