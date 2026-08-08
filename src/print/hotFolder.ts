import { mkdir, copyFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { PrintSize } from "../config/schema";

/**
 * DNP's Hot Folder Print utility is configured per print size/layout - one
 * watched folder per output profile - so a size-specific subfolder is used
 * rather than trying to encode size in the filename. Point one Hot Folder
 * Print instance at <hotFolderPath>/4x6 and another at
 * <hotFolderPath>/2x6-strip (see README for the exact utility setup).
 */
export function hotFolderPathFor(basePath: string, size: PrintSize): string {
  return path.join(basePath, size);
}

export async function dropIntoHotFolder(
  basePath: string,
  size: PrintSize,
  sourceFilePath: string
): Promise<string> {
  const dir = hotFolderPathFor(basePath, size);
  await mkdir(dir, { recursive: true });
  const destPath = path.join(dir, path.basename(sourceFilePath));
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
