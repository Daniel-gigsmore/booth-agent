import { Request, Response, NextFunction } from "express";

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
    if ((fromHeader ?? fromQuery) !== getSharedSecret()) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function isValidSecret(sharedSecret: string, provided: string | undefined): boolean {
  return provided === sharedSecret;
}
