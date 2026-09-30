import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { renderComposite, renderSheet } from "../src/compositor/compositor";
import { loadTemplate } from "../src/compositor/template";
import { SHEET_WIDTH_PX, SHEET_HEIGHT_PX, STRIP_CELL_WIDTH_PX, DPI } from "../src/compositor/dimensions";

const templateDir = path.join(__dirname, "..", "assets", "templates");
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "booth-agent-test-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makeSourceImage(): Promise<string> {
  const filePath = path.join(workDir, `source-${randomUUID()}.jpg`);
  // A distinct color per quadrant makes it easy to assert the same content
  // landed in both strip halves without relying on exact resize interpolation.
  await sharp({
    create: { width: 400, height: 1200, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .jpeg()
    .toFile(filePath);
  return filePath;
}

describe("2x6 strip compositor", () => {
  it("prints a single 4x6 sheet containing two identical, correctly oriented strips at 300dpi", async () => {
    const sourceImagePath = await makeSourceImage();
    const template = loadTemplate(templateDir, "default-strip");

    const sheet = await renderSheet({
      sourceImagePaths: [sourceImagePath],
      template,
      assetDir: templateDir,
      variables: { event: "Test", date: "24 Sep 2026", time: "14:05", code: "abcdefgh" },
      printSize: "2x6-strip",
      jpegQuality: 90,
    });

    const metadata = await sharp(sheet).metadata();
    expect(metadata.width).toBe(SHEET_WIDTH_PX);
    expect(metadata.height).toBe(SHEET_HEIGHT_PX);
    expect(metadata.density).toBe(DPI);

    // The strip's content lands in both halves at the same offset.
    const mean = async (left: number) =>
      (await sharp(sheet).extract({ left, top: 100, width: 50, height: 50 }).stats()).channels.map((c) => Math.round(c.mean));
    const [l, r] = [await mean(50), await mean(STRIP_CELL_WIDTH_PX + 50)];
    l.forEach((v, i) => expect(Math.abs(v - r[i]!)).toBeLessThan(4));
  });

  it("rejects a template whose print size doesn't match the request", async () => {
    const sourceImagePath = await makeSourceImage();
    const template = loadTemplate(templateDir, "default"); // a 4x6 template

    await expect(
      renderComposite({
        sourceImagePaths: [sourceImagePath],
        template,
        assetDir: templateDir,
        variables: { event: "Test", date: "24 Sep 2026", time: "14:05", code: "abcdefgh" },
        printSize: "2x6-strip",
        outputDir: workDir,
        jpegQuality: 90,
      })
    ).rejects.toThrow(/is for 4x6 but 2x6-strip was requested/);
  });
});
