import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { renderComposite } from "../src/compositor/compositor";
import { validateTemplate } from "../src/compositor/template";
import { TextVariables } from "../src/compositor/variables";

type Rgb = { r: number; g: number; b: number };
const RED: Rgb = { r: 220, g: 30, b: 30 };
const BLUE: Rgb = { r: 30, g: 30, b: 220 };
const VARS: TextVariables = { event: "Gigsmore Launch", date: "24 Sep 2026", time: "14:05", code: "e2e116bb" };

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "booth-elements-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function solid(color: Rgb, ext = "jpg"): Promise<string> {
  const file = path.join(workDir, `src-${randomUUID()}.${ext}`);
  await sharp({ create: { width: 600, height: 400, channels: 3, background: color } }).toFile(file);
  return file;
}

const photo = { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 100, height: 100 };

async function render(elements: unknown[], extra: Record<string, unknown> = {}, sources?: string[]) {
  const template = validateTemplate({
    id: "t",
    printSize: "4x6",
    cellWidthPx: 1200,
    cellHeightPx: 1800,
    elements,
    ...extra,
  });
  const result = await renderComposite({
    sourceImagePaths: sources ?? [await solid(RED)],
    template,
    assetDir: workDir,
    variables: VARS,
    printSize: "4x6",
    outputDir: workDir,
    jpegQuality: 95,
  });
  return result.filePath;
}

async function pixel(file: string, x: number, y: number): Promise<Rgb> {
  const { data } = await sharp(file).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return { r: data[0]!, g: data[1]!, b: data[2]! };
}

const near = (a: Rgb, b: Rgb) => Math.abs(a.r - b.r) < 40 && Math.abs(a.g - b.g) < 40 && Math.abs(a.b - b.b) < 40;

/** Pixels in a region darker than mid-grey: "ink" for black text on white. */
async function darkPixels(file: string, left: number, top: number, width: number, height: number): Promise<number> {
  const { data } = await sharp(file).extract({ left, top, width, height }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);
}

describe("element renderer", () => {
  it("fills the background colour", async () => {
    const file = await render([photo], { background: "#1e1edc" });
    expect(near(await pixel(file, 600, 900), BLUE)).toBe(true);
  });

  it("places each photo element's shot, including a repeated shot", async () => {
    const file = await render(
      [
        { ...photo, id: "a", shot: 1, x: 0, y: 0, width: 600, height: 400 },
        { ...photo, id: "b", shot: 0, x: 600, y: 0, width: 600, height: 400 },
        { ...photo, id: "c", shot: 1, x: 0, y: 1000, width: 600, height: 400 },
      ],
      {},
      [await solid(RED), await solid(BLUE)]
    );
    expect(near(await pixel(file, 300, 200), BLUE)).toBe(true);
    expect(near(await pixel(file, 900, 200), RED)).toBe(true);
    expect(near(await pixel(file, 300, 1200), BLUE)).toBe(true);
  });

  it("draws later elements on top and skips hidden ones", async () => {
    const file = await render([
      { ...photo, width: 600, height: 600 },
      { id: "r", type: "rect", fill: "#1e1edc", x: 0, y: 0, width: 300, height: 300 },
      { id: "h", type: "rect", fill: "#00ff00", x: 0, y: 0, width: 600, height: 600, hidden: true },
    ]);
    expect(near(await pixel(file, 150, 150), BLUE)).toBe(true);
    expect(near(await pixel(file, 450, 450), RED)).toBe(true);
  });

  it("applies a rect's opacity", async () => {
    const file = await render([photo, { id: "r", type: "rect", fill: "#ff0000", opacity: 0.5, x: 200, y: 200, width: 400, height: 400 }]);
    expect(near(await pixel(file, 400, 400), { r: 255, g: 128, b: 128 })).toBe(true);
  });

  it("rotates about the box centre", async () => {
    // 400x100 centred on (600, 900); at 90 degrees it becomes 100x400.
    const file = await render([photo, { id: "r", type: "rect", fill: "#1e1edc", x: 400, y: 850, width: 400, height: 100, rotation: 90 }]);
    expect(near(await pixel(file, 600, 750), BLUE)).toBe(true);
    expect(near(await pixel(file, 450, 900), { r: 255, g: 255, b: 255 })).toBe(true);
  });

  it("rotates clockwise for positive angles, like CSS rotate()", async () => {
    // Same bar at +30 degrees: its right end dips (y grows downward).
    // A point 180px along the axis from the centre is (756, 990).
    const file = await render([photo, { id: "r", type: "rect", fill: "#1e1edc", x: 400, y: 850, width: 400, height: 100, rotation: 30 }]);
    expect(near(await pixel(file, 756, 990), BLUE)).toBe(true);
    expect(near(await pixel(file, 756, 810), { r: 255, g: 255, b: 255 })).toBe(true);
  });

  it("crops elements past the edge, including ones larger than the cell", async () => {
    const file = await render([
      photo,
      { id: "big", type: "rect", fill: "#1e1edc", x: -100, y: 1700, width: 3000, height: 400 },
      { id: "off", type: "rect", fill: "#00ff00", x: 5000, y: 5000, width: 10, height: 10 },
    ]);
    expect(near(await pixel(file, 5, 1790), BLUE)).toBe(true);
    expect(near(await pixel(file, 1195, 1790), BLUE)).toBe(true);
  });

  it("draws an uploaded image stretched to its box", async () => {
    const asset = path.basename(await solid(BLUE, "png"));
    const file = await render([photo, { id: "i", type: "image", file: asset, x: 100, y: 500, width: 1000, height: 300 }]);
    expect(near(await pixel(file, 600, 650), BLUE)).toBe(true);
  });

  it("renders text inside its box, bolder when bold", async () => {
    const text = { id: "t", type: "text", text: "{event} {date}", font: "Manrope", size: 60, color: "#000000", x: 100, y: 600, width: 1000, height: 200 };
    const regular = await darkPixels(await render([photo, text]), 100, 600, 1000, 200);
    const bold = await darkPixels(await render([photo, { ...text, bold: true }]), 100, 600, 1000, 200);
    expect(regular).toBeGreaterThan(500);
    expect(bold).toBeGreaterThan(regular * 1.1);
    // Nothing leaks out of the box.
    const file = await render([photo, text]);
    expect(await darkPixels(file, 100, 400, 1000, 200)).toBe(0);
    expect(await darkPixels(file, 100, 800, 1000, 200)).toBe(0);
  });

  it("aligns text left and right within its box", async () => {
    const text = { id: "t", type: "text", text: "Hi", font: "Manrope", size: 80, color: "#000000", x: 0, y: 600, width: 1200, height: 200 };
    const left = await render([photo, { ...text, align: "left" }]);
    const right = await render([photo, { ...text, align: "right" }]);
    expect(await darkPixels(left, 0, 600, 300, 200)).toBeGreaterThan(0);
    expect(await darkPixels(left, 900, 600, 300, 200)).toBe(0);
    expect(await darkPixels(right, 900, 600, 300, 200)).toBeGreaterThan(0);
    expect(await darkPixels(right, 0, 600, 300, 200)).toBe(0);
  });

  it("escapes markup characters and skips empty text", async () => {
    const text = { id: "t", type: "text", text: "Tom & Jerry <3", font: "Great Vibes", size: 60, color: "#000000", x: 100, y: 600, width: 1000, height: 200 };
    expect(await darkPixels(await render([photo, text]), 100, 600, 1000, 200)).toBeGreaterThan(0);
    await expect(render([photo, { ...text, text: "   " }])).resolves.toBeTruthy();
  });
});
