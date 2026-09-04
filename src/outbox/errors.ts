/**
 * Marks an upload failure that will never resolve by waiting - the local file
 * backing the capture is gone, so no amount of network recovery brings it
 * back. The sync worker abandons these instead of retrying them forever.
 *
 * Everything else stays retryable with no attempt cap, deliberately. This
 * agent is built to sit offline for a whole event and drain afterwards, so an
 * attempt count is a bad discriminator: a 12-hour outage at the 120s max
 * backoff is ~360 attempts against a perfectly healthy capture. Only the
 * *kind* of error decides whether to give up, never how many times it failed.
 */
export class PermanentSyncError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentSyncError";
  }
}

/**
 * Whether an error is the filesystem saying the path isn't there any more.
 * Covers the realistic ways a capture's file disappears between the row being
 * written and the upload running: a cleanup pass, a moved data dir, a
 * yanked external drive.
 */
export function isMissingFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR" || code === "EPERM";
}
