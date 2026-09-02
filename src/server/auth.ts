import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

/**
 * The agent binds to loopback only, so the shared secret isn't defending
 * against network attackers - it's a guard against any other loopback
 * process (or a stray browser tab) poking these endpoints unintentionally.
 *
 * Accepts the secret either as `Authorization: Bearer <secret>` (used by the
 * kiosk UI's fetch/WS-upgrade calls) or as a `?token=` query param, since
 * plain <img>/MJPEG consumers of /liveview can't set custom headers.
 */
export function sharedSecretAuth(getSharedSecret: () => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization");
    const fromHeader = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const fromQuery = typeof req.query["token"] === "string" ? req.query["token"] : undefined;
    if (!isValidSecret(getSharedSecret(), fromHeader ?? fromQuery)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

/**
 * A plain `!==` compares byte-by-byte and returns on the first mismatch, so
 * how long the comparison takes leaks how many leading bytes of `provided`
 * were correct - a timing side channel against the secret's own bytes, on
 * top of it not defending against network attackers per the note above.
 * timingSafeEqual takes the same time regardless of where a mismatch falls.
 * It requires equal-length buffers, so a length mismatch is checked first -
 * that leaks only the secret's length, not any of its bytes, a standard and
 * accepted tradeoff for this comparison.
 */
export function isValidSecret(sharedSecret: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const expected = Buffer.from(sharedSecret);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
