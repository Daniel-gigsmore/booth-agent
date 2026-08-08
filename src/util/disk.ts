import { statfs } from "node:fs/promises";

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

/** Free/total space on the volume containing `targetPath`, or null if it can't be determined. */
export async function getDiskSpace(targetPath: string): Promise<DiskSpace | null> {
  try {
    const stats = await statfs(targetPath);
    return {
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    };
  } catch {
    return null;
  }
}
