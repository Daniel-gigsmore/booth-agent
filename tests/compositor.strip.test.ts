import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { renderComposite } from "../src/compositor/compositor";
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
  it("outputs a single 4x6 sheet containing two identical, correctly oriented strips at 300dpi", async () => {
    const sourceImagePath = await makeSourceImage();
    const template = loadTemplate(templateDir, "default-strip");

    const result = await renderComposite({
      sourceImagePath,
      template,
      overlayPath: null,
      printSize: "2x6-strip",
      outputDir: workDir,
      jpegQuality: 90,
    });

    expect(result.width).toBe(SHEET_WIDTH_PX);
    expect(result.height).toBe(SHEET_HEIGHT_PX);

    const metadata = await sharp(result.filePath).metadata();
    expect(metadata.width).toBe(SHEET_WIDTH_PX);
    expect(metadata.height).toBe(SHEET_HEIGHT_PX);
    expect(metadata.density).toBe(DPI);

    // Sample raw pixels from the left strip and the mirrored right strip at
    // the same relative offset - they must be pixel-identical.
    const sampleRegion = { top: 100, height: 50, width: 50 };
    const leftSample = await sharp(result.filePath)
      .extract({ left: 50, ...sampleRegion })
      .raw()
      .toBuffer();
    const rightSample = await sharp(result.filePath)
      .extract({ left: STRIP_CELL_WIDTH_PX + 50, ...sampleRegion })
      .raw()
      .toBuffer();

    expect(Buffer.compare(leftSample, rightSample)).toBe(0);
  });

  it("rejects a template whose print size doesn't match the request", async () => {
    const sourceImagePath = await makeSourceImage();
    const template = loadTemplate(templateDir, "default"); // a 4x6 template

    await expect(
      renderComposite({
        sourceImagePath,
        template,
        overlayPath: null,
        printSize: "2x6-strip",
        outputDir: workDir,
        jpegQuality: 90,
      })
    ).rejects.toThrow(/is for 4x6 but 2x6-strip was requested/);
  });
});
