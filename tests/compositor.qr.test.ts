import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import jsQR from "jsqr";
import { renderComposite } from "../src/compositor/compositor";
import { QrUrlSchema, validateTemplate } from "../src/compositor/template";

const URL = "https://booth.example/?event=evt&name=Gigsmore%20Launch&id=0b7c1f2e-1111-4222-8333-444455556666";
let workDir: string;
let source: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "booth-qr-"));
  source = path.join(workDir, "src.jpg");
  await sharp({ create: { width: 600, height: 400, channels: 3, background: "#808080" } }).toFile(source);
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const photo = { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 100, height: 100 };
const qr = { id: "q", type: "qr", x: 300, y: 600, width: 600, height: 400 };

async function render(elements: unknown[], qrUrl?: string): Promise<string> {
  const template = validateTemplate({ id: "t", printSize: "4x6", cellWidthPx: 1200, cellHeightPx: 1800, background: "#ffeedd", elements });
  const result = await renderComposite({
    sourceImagePaths: [source],
    template,
    assetDir: workDir,
    variables: { event: "", date: "", time: "", code: "" },
    qrUrl,
    printSize: "4x6",
    outputDir: workDir,
    jpegQuality: 95,
  });
  return result.filePath;
}

async function region(file: string, left: number, top: number, width: number, height: number) {
  const { data, info } = await sharp(file).extract({ left, top, width, height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

async function decode(file: string, left: number, top: number, width: number, height: number): Promise<string | null> {
  const r = await region(file, left, top, width, height);
  return jsQR(r.data, r.width, r.height)?.data ?? null;
}

const BG = [255, 238, 221];
/** JPEG shifts a flat colour by a step or two. */
const isBackground = (rgb: number[]) => rgb.every((v, i) => Math.abs(v - BG[i]!) <= 3);

async function pixel(file: string, x: number, y: number): Promise<[number, number, number]> {
  const { data } = await region(file, x, y, 1, 1);
  return [data[0]!, data[1]!, data[2]!];
}

describe("qr element", () => {
  it("draws a scannable code of the print's link, square and centred in its box", async () => {
    const file = await render([photo, qr], URL);
    expect(await decode(file, 300, 600, 600, 400)).toBe(URL);
    // 600x400 box: the code is 400 square, so the 100px either side is the layout background.
    expect(isBackground(await pixel(file, 350, 800))).toBe(true);
    expect(isBackground(await pixel(file, 850, 800))).toBe(true);
  });

  it("uses the element's colours", async () => {
    const file = await render([photo, { ...qr, color: "#1a237e", background: "#fff59d" }], URL);
    expect(await decode(file, 300, 600, 600, 400)).toBe(URL);
    // The code's top-left corner is its quiet zone, in the element's background.
    const [r, g, b] = await pixel(file, 402, 602);
    expect(r).toBeGreaterThan(240);
    expect(g).toBeGreaterThan(230);
    expect(b).toBeLessThan(180);
  });

  it("leaves the box empty when the print has no link", async () => {
    const file = await render([photo, qr]);
    expect(isBackground(await pixel(file, 600, 800))).toBe(true);
  });

  it("defaults to a dark code on white", () => {
    const t = validateTemplate({ id: "t", printSize: "4x6", cellWidthPx: 1200, cellHeightPx: 1800, elements: [photo, qr] });
    expect(t.elements[1]).toMatchObject({ type: "qr", color: "#000000", background: "#ffffff" });
  });
});

describe("QrUrlSchema", () => {
  it("accepts an https link", () => {
    expect(QrUrlSchema.parse(URL)).toBe(URL);
  });

  it.each(["http://booth.example/x", "javascript:alert(1)", "not a url", `https://booth.example/${"a".repeat(500)}`])(
    "rejects %s",
    (bad) => {
      expect(QrUrlSchema.safeParse(bad).success).toBe(false);
    }
  );
});
