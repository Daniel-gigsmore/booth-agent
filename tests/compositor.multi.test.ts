import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { renderComposite } from "../src/compositor/compositor";
import { loadTemplate } from "../src/compositor/template";
import { SHEET_WIDTH_PX, SHEET_HEIGHT_PX } from "../src/compositor/dimensions";

const templateDir = path.join(__dirname, "..", "assets", "templates");
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "booth-agent-multi-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

type Rgb = { r: number; g: number; b: number };
const RED: Rgb = { r: 220, g: 30, b: 30 };
const GREEN: Rgb = { r: 30, g: 200, b: 30 };
const BLUE: Rgb = { r: 30, g: 30, b: 220 };
const YELLOW: Rgb = { r: 230, g: 220, b: 30 };

async function solid(color: Rgb): Promise<string> {
  const filePath = path.join(workDir, `src-${randomUUID()}.jpg`);
  // 3:2 landscape, like the Canon's stills.
  await sharp({ create: { width: 600, height: 400, channels: 3, background: color } }).jpeg().toFile(filePath);
  return filePath;
}

async function pixel(file: string, x: number, y: number): Promise<Rgb> {
  const { data } = await sharp(file).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return { r: data[0]!, g: data[1]!, b: data[2]! };
}

function near(actual: Rgb, expected: Rgb): boolean {
  return Math.abs(actual.r - expected.r) < 40 && Math.abs(actual.g - expected.g) < 40 && Math.abs(actual.b - expected.b) < 40;
}

describe("multi-photo compositor", () => {
  it("puts each shot in its own slot of a landscape 4R grid, turned onto the portrait sheet", async () => {
    const template = loadTemplate(templateDir, "default-4r-grid");
    const sources = await Promise.all([RED, GREEN, BLUE, YELLOW].map(solid));

    const result = await renderComposite({
      sourceImagePaths: sources,
      template,
      overlayPath: null,
      printSize: "4x6",
      outputDir: workDir,
      jpegQuality: 90,
    });

    const meta = await sharp(result.filePath).metadata();
    expect([meta.width, meta.height]).toEqual([SHEET_WIDTH_PX, SHEET_HEIGHT_PX]);

    // Rotating the 1800x1200 cell 90deg clockwise maps cell (x, y) to sheet
    // (1199 - y, x). Sample the centre of each slot through that mapping.
    const colors = [RED, GREEN, BLUE, YELLOW];
    for (const [i, slot] of template.photoSlots.entries()) {
      const cx = slot.x + Math.floor(slot.width / 2);
      const cy = slot.y + Math.floor(slot.height / 2);
      const got = await pixel(result.filePath, template.cellHeightPx - 1 - cy, cx);
      expect(near(got, colors[i]!), `slot ${i + 1} got ${JSON.stringify(got)}`).toBe(true);
    }
  });

  it("still fills every slot from a single photo", async () => {
    const template = loadTemplate(templateDir, "default-4r-grid");
    const result = await renderComposite({
      sourceImagePaths: [await solid(BLUE)],
      template,
      overlayPath: null,
      printSize: "4x6",
      outputDir: workDir,
      jpegQuality: 90,
    });
    for (const slot of template.photoSlots) {
      const cx = slot.x + Math.floor(slot.width / 2);
      const cy = slot.y + Math.floor(slot.height / 2);
      expect(near(await pixel(result.filePath, template.cellHeightPx - 1 - cy, cx), BLUE)).toBe(true);
    }
  });
});
