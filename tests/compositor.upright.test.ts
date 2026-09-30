import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { printFileFor, printSheet, renderComposite } from "../src/compositor/compositor";
import { loadTemplate } from "../src/compositor/template";
import { SHEET_WIDTH_PX, SHEET_HEIGHT_PX, STRIP_CELL_WIDTH_PX, STRIP_CELL_HEIGHT_PX, DPI } from "../src/compositor/dimensions";

const templateDir = path.join(__dirname, "..", "assets", "templates");
const variables = { event: "Test", date: "24 Sep 2026", time: "14:05", code: "abcdefgh" };
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "booth-agent-upright-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

type Rgb = { r: number; g: number; b: number };
const RED: Rgb = { r: 220, g: 30, b: 30 };
const BLUE: Rgb = { r: 30, g: 30, b: 220 };

async function solid(color: Rgb, width = 600, height = 400): Promise<string> {
  const filePath = path.join(workDir, `src-${randomUUID()}.jpg`);
  await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toFile(filePath);
  return filePath;
}

async function size(input: string | Buffer): Promise<[number, number]> {
  const { width = 0, height = 0 } = await sharp(input).metadata();
  return [width, height];
}

async function pixel(input: string | Buffer, x: number, y: number): Promise<Rgb> {
  const { data } = await sharp(input).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return { r: data[0]!, g: data[1]!, b: data[2]! };
}

const near = (a: Rgb, b: Rgb) => Math.abs(a.r - b.r) < 40 && Math.abs(a.g - b.g) < 40 && Math.abs(a.b - b.b) < 40;

describe("the saved composite is the photo the guest sees, upright", () => {
  it("keeps a landscape 4x6 layout landscape", async () => {
    const template = loadTemplate(templateDir, "default-4r-grid");
    const result = await renderComposite({
      sourceImagePaths: [await solid(RED)],
      template,
      assetDir: templateDir,
      variables,
      printSize: "4x6",
      outputDir: workDir,
      jpegQuality: 90,
    });
    expect(await size(result.filePath)).toEqual([SHEET_HEIGHT_PX, SHEET_WIDTH_PX]);
    expect([result.width, result.height]).toEqual([SHEET_HEIGHT_PX, SHEET_WIDTH_PX]);
    expect((await sharp(result.filePath).metadata()).density).toBe(DPI);
  });

  it("saves one strip for a 2x6 layout, not the two-up sheet", async () => {
    const template = loadTemplate(templateDir, "default-strip");
    const result = await renderComposite({
      sourceImagePaths: [await solid(RED, 400, 1200)],
      template,
      assetDir: templateDir,
      variables,
      printSize: "2x6-strip",
      outputDir: workDir,
      jpegQuality: 90,
    });
    expect(await size(result.filePath)).toEqual([STRIP_CELL_WIDTH_PX, STRIP_CELL_HEIGHT_PX]);
  });
});

describe("printSheet turns the photo into what the portrait 4x6 printer takes", () => {
  it("turns a landscape photo a quarter clockwise onto the sheet", async () => {
    // Left half red, right half blue: after a clockwise quarter turn, red is on top.
    const photo = await sharp({ create: { width: SHEET_HEIGHT_PX, height: SHEET_WIDTH_PX, channels: 3, background: BLUE } })
      .composite([{ input: { create: { width: SHEET_HEIGHT_PX / 2, height: SHEET_WIDTH_PX, channels: 3, background: RED } }, left: 0, top: 0 }])
      .jpeg()
      .toBuffer();
    const sheet = await printSheet(photo, 90);
    expect(await size(sheet)).toEqual([SHEET_WIDTH_PX, SHEET_HEIGHT_PX]);
    expect(near(await pixel(sheet, 600, 300), RED)).toBe(true);
    expect(near(await pixel(sheet, 600, 1500), BLUE)).toBe(true);
    expect((await sharp(sheet).metadata()).density).toBe(DPI);
  });

  it("puts a strip on the sheet twice, side by side", async () => {
    const strip = await sharp({ create: { width: STRIP_CELL_WIDTH_PX, height: STRIP_CELL_HEIGHT_PX, channels: 3, background: RED } })
      .composite([{ input: { create: { width: 100, height: 100, channels: 3, background: BLUE } }, left: 50, top: 100 }])
      .jpeg()
      .toBuffer();
    const sheet = await printSheet(strip, 90);
    expect(await size(sheet)).toEqual([SHEET_WIDTH_PX, SHEET_HEIGHT_PX]);
    // Same content in both halves (JPEG noise aside): the blue square at (100, 150) and red around it.
    for (const offset of [0, STRIP_CELL_WIDTH_PX]) {
      expect(near(await pixel(sheet, offset + 100, 150), BLUE)).toBe(true);
      expect(near(await pixel(sheet, offset + 400, 900), RED)).toBe(true);
    }
  });

  it("leaves a portrait 4x6 (or an older, already-turned composite) exactly as it is", async () => {
    const photo = await sharp({ create: { width: SHEET_WIDTH_PX, height: SHEET_HEIGHT_PX, channels: 3, background: RED } }).jpeg().toBuffer();
    expect(await printSheet(photo, 90)).toBe(photo);
  });
});

describe("printFileFor gives the print queue a file the printer takes", () => {
  it("writes the turned sheet next to a landscape composite once, and reuses it", async () => {
    const photo = await solid(RED, SHEET_HEIGHT_PX, SHEET_WIDTH_PX);
    const file = await printFileFor(photo, 90);
    expect(file).not.toBe(photo);
    expect(path.dirname(file)).toBe(path.dirname(photo));
    expect(await size(file)).toEqual([SHEET_WIDTH_PX, SHEET_HEIGHT_PX]);
    const firstWrite = (await stat(file)).mtimeMs;
    expect(await printFileFor(photo, 90)).toBe(file);
    expect((await stat(file)).mtimeMs).toBe(firstWrite);
  });

  it("hands back a sheet-shaped composite itself", async () => {
    const photo = await solid(RED, SHEET_WIDTH_PX, SHEET_HEIGHT_PX);
    expect(await printFileFor(photo, 90)).toBe(photo);
  });

  it("hands back a file it can't read as an image unchanged, as the hot folder always got it", async () => {
    const junk = path.join(workDir, "junk.jpg");
    await writeFile(junk, "not a jpeg");
    expect(await printFileFor(junk, 90)).toBe(junk);
    expect(await readFile(junk, "utf8")).toBe("not a jpeg");
  });
});
