import { mkdir, copyFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { PrintSize } from "../config/schema";

/**
 * DNP Hot Folder Print (verified against the current v3.6.37 Blazor-based
 * rewrite, live, against a physical DS-RX1HS) doesn't accept an arbitrary
 * user-chosen watched folder the way the classic version's documentation
 * describes - it watches a fixed set of folders under its own install
 * directory, one per print profile:
 *   - "s4x6"   - whole 4x6 photo, printed uncut
 *   - "s6x2_2" - a 4x6 sheet with the printer's cutter engaged, producing
 *                two separate 2x6 strips. This is the target for our
 *                "2x6-strip" printSize: the compositor already renders the
 *                full two-up 4x6 sheet (two identical strips side by side),
 *                and HFP/the printer do the physical cut.
 * Point `printing.hotFolderPath` at that install's Prints folder (typically
 * `C:\DNP\HotFolderPrint\Prints`) - these "s..." names are this rewrite's
 * own internal scheme, not a documented public API, so re-verify them
 * against `<hotFolderPath>\..\Logs\log-<date>.txt` (look for "Print ...:"
 * lines) if you're on a different HFP version.
 */
const HFP_FOLDER_BY_SIZE: Record<PrintSize, string> = {
  "4x6": "s4x6",
  "2x6-strip": "s6x2_2",
};

export function hotFolderPathFor(basePath: string, size: PrintSize): string {
  return path.join(basePath, HFP_FOLDER_BY_SIZE[size]);
}

/**
 * Copies `sourceFilePath` into the size's hot folder under a name derived
 * from `jobId`, not the source file's own basename. Multiple print jobs
 * commonly share one composite file (reprints, "print another copy"), and
 * naming the destination after the source would make later jobs silently
 * overwrite earlier ones before Hot Folder Print picks them up - each job
 * needs its own file on disk regardless of how many jobs point at the same
 * source image.
 */
export async function dropIntoHotFolder(
  basePath: string,
  size: PrintSize,
  jobId: string,
  sourceFilePath: string
): Promise<string> {
  const dir = hotFolderPathFor(basePath, size);
  await mkdir(dir, { recursive: true });
  const destPath = path.join(dir, `${jobId}${path.extname(sourceFilePath)}`);
  await copyFile(sourceFilePath, destPath);
  return destPath;
}

/** Probes the hot folder root, which both per-size subfolders live under. */
export async function isHotFolderWritable(basePath: string): Promise<boolean> {
  try {
    await mkdir(basePath, { recursive: true });
    const probePath = path.join(basePath, `.booth-write-test-${process.pid}`);
    await writeFile(probePath, "ok");
    await unlink(probePath);
    return true;
  } catch {
    return false;
  }
}
