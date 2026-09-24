import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const COLORS = ["#e76f51", "#2a9d8f", "#e9c46a", "#457b9d", "#8d6a9f", "#6a994e"];

/**
 * Stand-in guest photos for layout previews and test prints: 3:2 like the
 * Canon's stills, a colour and a big number per shot, so the operator can
 * see which photo box gets which shot. Made once into dir and reused.
 */
export async function samplePhotos(dir: string, count: number): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  // ponytail: no lock; two previews racing on a fresh dir could both write the
  // same file. Fine for one operator; add a lock if previews become concurrent.
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const file = path.join(dir, `sample-${i + 1}.jpg`);
      try {
        await access(file);
        return file;
      } catch {
        // not made yet
      }
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1200">` +
        `<rect width="1800" height="1200" fill="${COLORS[i % COLORS.length]}"/>` +
        `<text x="900" y="600" font-family="sans-serif" font-size="600" font-weight="bold" fill="#ffffff" ` +
        `text-anchor="middle" dominant-baseline="central">${i + 1}</text></svg>`;
      await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toFile(file);
      return file;
    })
  );
}
