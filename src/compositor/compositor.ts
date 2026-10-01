import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { Sharp, OverlayOptions } from "sharp";
import { v4 as uuidv4 } from "uuid";
import QRCode from "qrcode";
import { EventTemplate, LayoutElement, QrElement, TextElement } from "./template";
import { findFont, FONT_DIR } from "./fonts";
import { TextVariables, fillVariables } from "./variables";
import {
  SHEET_WIDTH_PX,
  SHEET_HEIGHT_PX,
  STRIP_CELL_WIDTH_PX,
  STRIP_CELL_HEIGHT_PX,
  DPI,
} from "./dimensions";
import { PrintSize } from "../config/schema";

export interface CompositeParams {
  /** One photo per shot, in shot order. Fewer photos than shots repeat from the start. */
  sourceImagePaths: string[];
  template: EventTemplate;
  /** Where the template's image assets live (the template directory). */
  assetDir: string;
  /** Values for {event} {date} {time} {code} in text elements. */
  variables: TextVariables;
  /** What qr elements encode: the guest's download link. Unset = qr elements are left out. */
  qrUrl?: string | undefined;
  printSize: PrintSize;
  outputDir: string;
  jpegQuality: number;
}

export interface CompositeResult {
  filePath: string;
  width: number;
  height: number;
}

/** Everything renderComposite needs except where to save the file. */
export type SheetParams = Omit<CompositeParams, "outputDir">;

interface CellParams {
  sourceImagePaths: string[];
  template: EventTemplate;
  assetDir: string;
  variables: TextVariables;
  qrUrl?: string | undefined;
}

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

const escapeMarkup = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Composite entry for an image placed at (left, top), cropped to a
 * canvasW x canvasH canvas. sharp rejects overlays larger than the canvas, so
 * everything is cropped first. Null when nothing of it is on the canvas.
 */
async function cropped(input: Buffer, left: number, top: number, canvasW: number, canvasH: number): Promise<OverlayOptions | null> {
  const { width = 0, height = 0 } = await sharp(input).metadata();
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(canvasW, left + width);
  const y1 = Math.min(canvasH, top + height);
  if (x1 <= x0 || y1 <= y0) return null;
  const part = await sharp(input)
    .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
    .png()
    .toBuffer();
  return { input: part, left: x0, top: y0 };
}

/**
 * Text wrapped to the box width, aligned across, centred down. Pango trims
 * its output to the text itself, so the text is placed on a transparent
 * box-sized canvas here; text taller than the box is cropped.
 */
async function renderText(el: TextElement, variables: TextVariables): Promise<Buffer | null> {
  const text = fillVariables(el.text, variables);
  if (!text.trim()) return null;
  const font = findFont(el.font)!; // validateTemplate only lets bundled fonts through
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${el.color}">${escapeMarkup(text)}</span>`,
      font: `${font.family}${el.bold && font.hasBold ? " Bold" : ""} ${el.size}px`,
      fontfile: path.join(FONT_DIR, font.file),
      width: el.width,
      align: el.align === "center" ? "centre" : el.align,
      wrap: "word-char",
      rgba: true,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left =
    el.align === "left" ? 0 : el.align === "right" ? el.width - info.width : Math.round((el.width - info.width) / 2);
  const placed = await cropped(data, left, Math.round((el.height - info.height) / 2), el.width, el.height);
  return sharp({ create: { width: el.width, height: el.height, channels: 4, background: TRANSPARENT } })
    .composite(placed ? [placed] : [])
    .png()
    .toBuffer();
}

/** The link as a square code (with its quiet zone) centred on a transparent box-sized canvas. */
async function renderQr(el: QrElement, url: string): Promise<Buffer> {
  const side = Math.min(el.width, el.height);
  const code = await QRCode.toBuffer(url, { width: side, color: { dark: el.color, light: el.background } });
  return sharp({ create: { width: el.width, height: el.height, channels: 4, background: TRANSPARENT } })
    .composite([{ input: code, gravity: "centre" }])
    .png()
    .toBuffer();
}

/** One element drawn at its own width x height, unrotated. Null = nothing to draw. */
async function renderElement(el: LayoutElement, params: CellParams): Promise<Buffer | null> {
  switch (el.type) {
    case "photo":
      return sharp(params.sourceImagePaths[el.shot % params.sourceImagePaths.length])
        .rotate() // normalize EXIF orientation before placing
        .resize(el.width, el.height, { fit: "cover", position: "centre" })
        .png()
        .toBuffer();
    case "image":
      return sharp(path.join(params.assetDir, el.file))
        .rotate() // normalize EXIF orientation before placing
        .resize(el.width, el.height, { fit: "fill" })
        .png()
        .toBuffer();
    case "rect": {
      const r = Math.min(el.radius, el.width / 2, el.height / 2);
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${el.width}" height="${el.height}">` +
        `<rect width="${el.width}" height="${el.height}" rx="${r}" ry="${r}" fill="${el.fill}" fill-opacity="${el.opacity}"/></svg>`;
      return sharp(Buffer.from(svg)).png().toBuffer();
    }
    case "text":
      return renderText(el, params.variables);
    case "qr":
      return params.qrUrl ? renderQr(el, params.qrUrl) : null;
  }
}

/** Renders one printable cell (a 4x6 sheet, or a single 2x6 strip) as a PNG buffer. */
async function renderCell(params: CellParams): Promise<Buffer> {
  const { sourceImagePaths, template } = params;
  if (sourceImagePaths.length === 0) throw new Error("renderComposite needs at least one source image");

  const composites: OverlayOptions[] = [];
  for (const el of template.elements) {
    if (el.hidden) continue;
    let image = await renderElement(el, params);
    if (!image) continue;
    let left = el.x;
    let top = el.y;
    if (el.rotation !== 0) {
      // Rotating grows the image to its new bounding box; keep the centre put.
      const { data, info } = await sharp(image)
        .rotate(el.rotation, { background: TRANSPARENT })
        .png()
        .toBuffer({ resolveWithObject: true });
      image = data;
      left = Math.round(el.x + el.width / 2 - info.width / 2);
      top = Math.round(el.y + el.height / 2 - info.height / 2);
    }
    const entry = await cropped(image, left, top, template.cellWidthPx, template.cellHeightPx);
    if (entry) composites.push(entry);
  }

  return sharp({
    create: {
      width: template.cellWidthPx,
      height: template.cellHeightPx,
      channels: 4,
      background: template.background,
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

/**
 * The photo as the guest holds it, as a 300dpi JPEG: a 4x6 layout at its own
 * orientation (1800x1200 landscape or 1200x1800 portrait), a 2x6 layout as one
 * 600x1800 strip. This is what is saved, uploaded, shown in the albums and
 * downloaded; printSheet() turns it into what the printer takes.
 */
export async function renderPhoto(params: SheetParams): Promise<Buffer> {
  if (params.template.printSize !== params.printSize) {
    throw new Error(
      `Template "${params.template.id}" is for ${params.template.printSize} but ${params.printSize} was requested`
    );
  }
  const cell = await renderCell(params);
  const landscape = params.template.cellWidthPx > params.template.cellHeightPx;
  const [width, height] =
    params.printSize === "2x6-strip"
      ? [STRIP_CELL_WIDTH_PX, STRIP_CELL_HEIGHT_PX]
      : landscape
        ? [SHEET_HEIGHT_PX, SHEET_WIDTH_PX]
        : [SHEET_WIDTH_PX, SHEET_HEIGHT_PX];
  return sharp(cell)
    .resize(width, height, { fit: "fill" })
    .jpeg({ quality: params.jpegQuality })
    .withMetadata({ density: DPI })
    .toBuffer();
}

/**
 * What the printer feeds is always a portrait 4x6 sheet. A landscape photo is
 * turned a quarter onto it (the guest turns the print round to look at it), a
 * strip goes on twice side by side for the DNP's two-up strip cutter, and
 * anything already sheet-shaped - a portrait photo, or a composite saved
 * before photos were kept upright - is returned untouched.
 */
export async function printSheet(photo: Buffer, jpegQuality: number): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(photo).metadata();
  let sheet: Sharp;
  if (width > height) {
    sheet = sharp(photo).rotate(90).resize(SHEET_WIDTH_PX, SHEET_HEIGHT_PX, { fit: "fill" });
  } else if (width === STRIP_CELL_WIDTH_PX && height === STRIP_CELL_HEIGHT_PX) {
    sheet = sharp({
      create: { width: SHEET_WIDTH_PX, height: SHEET_HEIGHT_PX, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).composite([
      { input: photo, left: 0, top: 0 },
      { input: photo, left: STRIP_CELL_WIDTH_PX, top: 0 },
    ]);
  } else {
    return photo;
  }
  return sheet.jpeg({ quality: jpegQuality }).withMetadata({ density: DPI }).toBuffer();
}

/** The print-ready sheet, in memory. Layout test prints use this. */
export async function renderSheet(params: SheetParams): Promise<Buffer> {
  return printSheet(await renderPhoto(params), params.jpegQuality);
}

/**
 * The file to hand the hot folder for a saved composite: the composite itself
 * when it is already sheet-shaped, otherwise its sheet, written once next to it
 * as <name>-sheet.jpg and reused for reprints. A file that isn't a readable
 * image is handed over unchanged, as the hot folder always got it.
 */
export async function printFileFor(photoPath: string, jpegQuality: number): Promise<string> {
  const sheetPath = photoPath.replace(/.jpe?g$/i, "") + "-sheet.jpg";
  if (await access(sheetPath).then(() => true, () => false)) return sheetPath;
  let photo: Buffer;
  let sheet: Buffer;
  try {
    photo = await readFile(photoPath);
    sheet = await printSheet(photo, jpegQuality);
  } catch {
    return photoPath;
  }
  if (sheet === photo) return photoPath;
  await writeFile(sheetPath, sheet);
  return sheetPath;
}

/** Renders the guest's photo (renderPhoto) and saves it under outputDir. */
export async function renderComposite(params: CompositeParams): Promise<CompositeResult> {
  const jpeg = await renderPhoto(params);
  await mkdir(params.outputDir, { recursive: true });
  const filePath = path.join(params.outputDir, `composite-${uuidv4()}.jpg`);
  await writeFile(filePath, jpeg);
  const { width = 0, height = 0 } = await sharp(jpeg).metadata();
  return { filePath, width, height };
}
