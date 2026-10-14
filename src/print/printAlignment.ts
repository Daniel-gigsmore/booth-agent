import sharp from "sharp";
import { SHEET_WIDTH_PX, SHEET_HEIGHT_PX, DPI } from "../compositor/dimensions";

export interface PrintAlignment {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export async function applyAlignment(
  sheet: Buffer,
  alignment: PrintAlignment,
  jpegQuality: number,
): Promise<Buffer> {
  if (alignment.scale === 100 && alignment.offsetX === 0 && alignment.offsetY === 0) return sheet;

  const { width = SHEET_WIDTH_PX, height = SHEET_HEIGHT_PX } = await sharp(sheet).metadata();
  const scaledW = Math.round(width * alignment.scale / 100);
  const scaledH = Math.round(height * alignment.scale / 100);
  const scaled = await sharp(sheet).resize(scaledW, scaledH).toBuffer();

  const left = Math.round((width - scaledW) / 2 + alignment.offsetX);
  const top = Math.round((height - scaledH) / 2 + alignment.offsetY);

  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: scaled, left, top }])
    .jpeg({ quality: jpegQuality })
    .withMetadata({ density: DPI })
    .toBuffer();
}
