import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import { EventTemplate } from "./template";
import {
  SHEET_WIDTH_PX,
  SHEET_HEIGHT_PX,
  STRIP_CELL_WIDTH_PX,
  STRIP_CELL_HEIGHT_PX,
  DPI,
} from "./dimensions";
import { PrintSize } from "../config/schema";

export interface CompositeParams {
  sourceImagePath: string;
  template: EventTemplate;
  overlayPath: string | null;
  printSize: PrintSize;
  outputDir: string;
  jpegQuality: number;
}

export interface CompositeResult {
  filePath: string;
  width: number;
  height: number;
}

/** Renders one printable cell (a 4x6 sheet, or a single 2x6 strip) as a PNG buffer. */
async function renderCell(params: {
  sourceImagePath: string;
  template: EventTemplate;
  overlayPath: string | null;
}): Promise<Buffer> {
  const { sourceImagePath, template, overlayPath } = params;

  const composites: sharp.OverlayOptions[] = [];
  for (const slot of template.photoSlots) {
    const photoBuffer = await sharp(sourceImagePath)
      .rotate() // normalize EXIF orientation before placing
      .resize(slot.width, slot.height, { fit: "cover", position: "centre" })
      .toBuffer();
    composites.push({ input: photoBuffer, left: slot.x, top: slot.y });
  }

  if (overlayPath) {
    const overlayBuffer = await sharp(overlayPath)
      .resize(template.cellWidthPx, template.cellHeightPx, { fit: "fill" })
      .toBuffer();
    composites.push({ input: overlayBuffer, left: 0, top: 0 });
  }

  return sharp({
    create: {
      width: template.cellWidthPx,
      height: template.cellHeightPx,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
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

  let finalImage: sharp.Sharp;

  if (params.printSize === "4x6") {
    const cell = await renderCell({
      sourceImagePath: params.sourceImagePath,
      template: params.template,
      overlayPath: params.overlayPath,
    });
    finalImage = sharp(cell).resize(SHEET_WIDTH_PX, SHEET_HEIGHT_PX, { fit: "fill" });
  } else {
    const cell = await renderCell({
      sourceImagePath: params.sourceImagePath,
      template: params.template,
      overlayPath: params.overlayPath,
    });
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
