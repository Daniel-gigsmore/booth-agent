import sharp from "sharp";

/** Wraps a PNG buffer in a minimal single-image ICO container (PNG-in-ICO is valid since Windows Vista). */
function pngToIco(png: Buffer, size: number): Buffer {
  const iconDir = Buffer.alloc(6);
  iconDir.writeUInt16LE(0, 0); // reserved
  iconDir.writeUInt16LE(1, 2); // type: 1 = icon
  iconDir.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // color count
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // size of image data
  entry.writeUInt32LE(iconDir.length + entry.length, 12); // offset of image data

  return Buffer.concat([iconDir, entry, png]);
}

export type TrayStatusColor = "green" | "amber" | "red" | "gray";

const COLORS: Record<TrayStatusColor, { r: number; g: number; b: number }> = {
  green: { r: 34, g: 176, b: 90 },
  amber: { r: 224, g: 158, b: 30 },
  red: { r: 210, g: 60, b: 60 },
  gray: { r: 140, g: 140, b: 140 },
};

/** Renders a simple solid-color dot as a 32x32 ICO, used as the tray status indicator. */
export async function renderStatusIconBase64(color: TrayStatusColor): Promise<string> {
  const size = 32;
  const { r, g, b } = COLORS[color];
  const png = await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${
            size / 2 - 2
          }" fill="rgb(${r},${g},${b})"/></svg>`
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();

  return pngToIco(png, size).toString("base64");
}
