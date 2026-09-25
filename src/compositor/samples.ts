import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { FONT_DIR } from "./fonts";

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
      const digit = await sharp({
        text: {
          text: `<span foreground="#ffffff">${i + 1}</span>`,
          font: "Manrope Bold 600px",
          fontfile: path.join(FONT_DIR, "Manrope.ttf"),
          rgba: true,
        },
      })
        .png()
        .toBuffer();
      const jpeg = await sharp({
        create: { width: 1800, height: 1200, channels: 3, background: COLORS[i % COLORS.length]! },
      })
        .composite([{ input: digit, gravity: "centre" }])
        .jpeg({ quality: 85 })
        .toBuffer();
      // Atomic: a crash mid-write must never leave a corrupt file that the
      // access() check above then reuses forever.
      const tmp = `${file}.tmp`;
      await writeFile(tmp, jpeg);
      await rename(tmp, file);
      return file;
    })
  );
}
