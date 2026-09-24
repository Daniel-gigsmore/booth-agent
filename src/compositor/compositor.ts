import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp, { Sharp, OverlayOptions } from "sharp";
import { v4 as uuidv4 } from "uuid";
import { EventTemplate, LayoutElement, TextElement } from "./template";
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
  printSize: PrintSize;
  outputDir: string;
  jpegQuality: number;
}

export interface CompositeResult {
  filePath: string;
  width: number;
  height: number;
}

interface CellParams {
  sourceImagePaths: string[];
  template: EventTemplate;
  assetDir: string;
  variables: TextVariables;
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
 * Produces the final print-ready JPEG at 300dpi. For "4x6" the cell fills the
 * whole sheet. For "2x6-strip" the same cell is rendered once and mirrored at
 * left and right halves of the sheet, so the DNP's two-up strip cutter
 * produces two identical strips per print.
 */
export async function renderComposite(params: CompositeParams): Promise<CompositeResult> {
  if (params.template.printSize !== params.printSize) {
    throw new Error(
      `Template "${params.template.id}" is for ${params.template.printSize} but ${params.printSize} was requested`
    );
  }
  await mkdir(params.outputDir, { recursive: true });
  const fileName = `composite-${uuidv4()}.jpg`;
  const filePath = path.join(params.outputDir, fileName);

  let finalImage: Sharp;

  if (params.printSize === "4x6") {
    const cell = await renderCell(params);
    // A landscape layout is turned a quarter onto the portrait sheet the
    // printer feeds; the guest just turns the print round to look at it.
    const landscape = params.template.cellWidthPx > params.template.cellHeightPx;
    const upright = landscape ? await sharp(cell).rotate(90).toBuffer() : cell;
    finalImage = sharp(upright).resize(SHEET_WIDTH_PX, SHEET_HEIGHT_PX, { fit: "fill" });
  } else {
    const cell = await renderCell(params);
    const cellResized = await sharp(cell)
      .resize(STRIP_CELL_WIDTH_PX, STRIP_CELL_HEIGHT_PX, { fit: "fill" })
      .toBuffer();

    finalImage = sharp({
      create: {
        width: SHEET_WIDTH_PX,
        height: SHEET_HEIGHT_PX,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).composite([
      { input: cellResized, left: 0, top: 0 },
      { input: cellResized, left: STRIP_CELL_WIDTH_PX, top: 0 },
    ]);
  }

  await finalImage
    .jpeg({ quality: params.jpegQuality })
    .withMetadata({ density: DPI })
    .toFile(filePath);

  return { filePath, width: SHEET_WIDTH_PX, height: SHEET_HEIGHT_PX };
}
