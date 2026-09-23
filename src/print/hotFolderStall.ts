import { access } from "node:fs/promises";
import { OutboxStore } from "../outbox/outboxStore";
import { PrintJobRow } from "../outbox/types";

/**
 * A file that lands in the hot folder and is never picked up is the worst
 * failure this booth has, because every other signal says it is fine.
 *
 * The copy into the hot folder succeeds, so `hot-folder-unwritable` stays
 * green. HFP keeps writing its status file, so the printer keeps reporting
 * STATUS_OK. `print-completed` fires off a timer, so the kiosk cheerfully
 * tells the guest their photo is ready. Nothing comes out of the printer and
 * nothing anywhere says so - it is found when a guest complains, which at a
 * 300-guest event is dozens of prints too late.
 *
 * Seen in practice when HFP re-initialised and started watching a
 * `<size>\<printer>-<n>\` subfolder instead of the folder the agent drops
 * into, and separately when the HFP window was closed while its background
 * pieces kept the status file warm. Both are invisible to every other check.
 *
 * Ground truth is simply whether the file we dropped is still on disk. HFP
 * consumes a file by moving it, so its continued presence means it was never
 * claimed. That is the copy in the hot folder (dropped_path), never the
 * composite it was copied from (file_path) - the composite deliberately stays
 * on disk, so checking it would flag every print ever made.
 */
export interface StalledPrints {
  /** Dropped files still sitting in the hot folder past the stall threshold. */
  count: number;
  oldestDroppedAt: string | null;
  oldestAgeSeconds: number | null;
  /** Paths of the stalled files, oldest first. Capped for display. */
  files: string[];
}

export const NO_STALLED_PRINTS: StalledPrints = {
  count: 0,
  oldestDroppedAt: null,
  oldestAgeSeconds: null,
  files: [],
};

const MAX_REPORTED_FILES = 5;

/**
 * Checks every dropped-but-not-yet-confirmed print job against the filesystem,
 * records the ones HFP has taken, and reports the ones it has not.
 *
 * Recording consumption is what keeps this cheap enough to run on every
 * `/health` call: a job is stat'd until it is confirmed gone and then never
 * again, so in a healthy booth this touches the disk once or twice per print
 * rather than once per print per poll for the life of the event.
 */
export async function reconcileHotFolderDrops(
  store: OutboxStore,
  stallAfterSeconds: number,
  now: Date = new Date()
): Promise<StalledPrints> {
  const pending = store.getUnconsumedDroppedPrintJobs();
  if (pending.length === 0) return NO_STALLED_PRINTS;

  const stalled: Array<{ job: PrintJobRow; ageSeconds: number }> = [];

  for (const job of pending) {
    // Nothing verifiable to check (a pre-dropped_path row the db migration
    // missed). Settle it rather than guess at a path.
    if (!job.dropped_path) {
      store.markPrintJobConsumed(job.id, now.toISOString());
      continue;
    }
    if (await fileStillThere(job.dropped_path)) {
      // dropped_at should always be set for a dropped job; fall back to
      // queued_at rather than skipping, so a malformed row still gets noticed.
      const droppedAtMs = Date.parse(job.dropped_at ?? job.queued_at);
      if (Number.isNaN(droppedAtMs)) continue;
      const ageSeconds = Math.floor((now.getTime() - droppedAtMs) / 1000);
      if (ageSeconds >= stallAfterSeconds) stalled.push({ job, ageSeconds });
      continue;
    }
    store.markPrintJobConsumed(job.id, now.toISOString());
  }

  if (stalled.length === 0) return NO_STALLED_PRINTS;

  stalled.sort((a, b) => b.ageSeconds - a.ageSeconds);
  const oldest = stalled[0];
  if (!oldest) return NO_STALLED_PRINTS;
  return {
    count: stalled.length,
    oldestDroppedAt: oldest.job.dropped_at ?? oldest.job.queued_at,
    oldestAgeSeconds: oldest.ageSeconds,
    files: stalled.slice(0, MAX_REPORTED_FILES).map((s) => s.job.dropped_path ?? s.job.file_path),
  };
}

async function fileStillThere(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
