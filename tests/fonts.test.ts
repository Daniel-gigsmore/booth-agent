import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { FONTS, FONT_DIR, findFont, fontFilePath } from "../src/compositor/fonts";

async function ink(font: string, fontfile: string): Promise<number> {
  const { data } = await sharp({
    text: { text: '<span foreground="#000000">Gigsmore 2026</span>', font, fontfile, rgba: true },
  })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 3; i < data.length; i += 4) sum += data[i]!;
  return sum;
}

describe("bundled fonts", () => {
  it.each(FONTS.map((f) => [f.family, f] as const))("%s is on disk and renders", async (_family, font) => {
    const file = path.join(FONT_DIR, font.file);
    expect(existsSync(file)).toBe(true);
    const regular = await ink(`${font.family} 48px`, file);
    expect(regular).toBeGreaterThan(0);
    if (font.hasBold) expect(await ink(`${font.family} Bold 48px`, file)).toBeGreaterThan(regular * 1.1);
  });

  it("finds fonts by family", () => {
    expect(findFont("Manrope")?.file).toBe("Manrope.ttf");
    expect(findFont("Comic Sans")).toBeUndefined();
  });

  it("only resolves bundled font files", () => {
    expect(fontFilePath("Manrope.ttf")).toBe(path.join(FONT_DIR, "Manrope.ttf"));
    expect(fontFilePath("../../booth.config.json")).toBeNull();
    expect(fontFilePath("OFL-Manrope.txt")).toBeNull();
  });
});
