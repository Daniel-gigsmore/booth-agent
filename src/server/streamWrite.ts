import { Response } from "express";
import { once } from "node:events";

/**
 * Writes a chunk and, if the kernel write buffer is full, waits before
 * returning - callers should stop writing if `res.destroyed` afterward.
 *
 * Waiting on "drain" alone hangs forever if the client disconnects while a
 * write is backpressured: confirmed live that the response emits "close" in
 * that case, never "drain", and `events.once()` only special-cases "error"
 * for early rejection, not "close". Racing "drain" against "close" is what
 * actually unblocks a stalled writer (e.g. /liveview) on client disconnect,
 * instead of leaking that request's handler closure for the life of the
 * process.
 */
export async function writeBackpressureAware(res: Response, data: string | Buffer): Promise<void> {
  if (!res.write(data)) {
    await Promise.race([once(res, "drain"), once(res, "close")]);
  }
}
