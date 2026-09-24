import path from "node:path";

/**
 * Fonts a layout's text may use. They ship with the agent (OFL, from
 * github.com/google/fonts) and the kiosk editor loads the same files through
 * GET /fonts/:file, so the editor preview and the print use identical fonts.
 */
export interface BundledFont {
  family: string;
  file: string;
  /** Variable fonts with a weight axis render "Bold" as their 700 weight. */
  hasBold: boolean;
}

export const FONT_DIR = path.join(__dirname, "..", "..", "assets", "fonts");

export const FONTS: readonly BundledFont[] = [
  { family: "Manrope", file: "Manrope.ttf", hasBold: true },
  { family: "Bricolage Grotesque", file: "BricolageGrotesque.ttf", hasBold: true },
  { family: "Playfair Display", file: "PlayfairDisplay.ttf", hasBold: true },
  { family: "Great Vibes", file: "GreatVibes.ttf", hasBold: false },
];

export function findFont(family: string): BundledFont | undefined {
  return FONTS.find((f) => f.family === family);
}

/** Path of a bundled font file. Null for anything else, so GET /fonts/:file can't serve other files. */
export function fontFilePath(file: string): string | null {
  return FONTS.some((f) => f.file === file) ? path.join(FONT_DIR, file) : null;
}
