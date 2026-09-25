/**
 * Raw EDSDK property codes -> what an operator reads on the Status tab.
 * Unknown codes show as hex rather than guessing.
 */

const hexCode = (n: number): string => `0x${(n >>> 0).toString(16).toUpperCase()}`;

const AE_MODES: Record<number, string> = {
  0: "P", 1: "Tv", 2: "Av", 3: "M", 4: "Bulb", 9: "Auto",
  19: "Creative Auto", 20: "Movie", 22: "Scene Intelligent Auto", 25: "SCN",
};

const AF_MODES: Record<number, string> = { 0: "One-Shot", 1: "AI Servo", 2: "AI Focus", 3: "Manual" };

/** 0xFFFFFFFF is how EDSDK says "on AC power"; 0-100 is a percentage. */
export function batteryLevel(raw: number): number | "ac" | null {
  if (raw >>> 0 === 0xffffffff) return "ac";
  return raw >= 0 && raw <= 100 ? raw : null;
}

export const aeModeLabel = (raw: number): string => AE_MODES[raw] ?? hexCode(raw);
export const afModeLabel = (raw: number): string => AF_MODES[raw] ?? hexCode(raw);

const FORMAT_NAMES: Record<number, string> = { 1: "JPEG", 2: "RAW", 4: "RAW", 6: "RAW", 8: "HEIF" };

/**
 * EdsImageQuality packs two images: the primary format is bits 20-23, the
 * secondary is bits 4-7 (0 = no image). e.g. 0x00640013 = RAW + L JPEG Fine.
 */
export function imageQuality(raw: number): { label: string; hasJpeg: boolean } {
  const formats = [(raw >>> 20) & 0xf, (raw >>> 4) & 0xf].filter((f) => f !== 0);
  const names = formats.map((f) => FORMAT_NAMES[f] ?? hexCode(f));
  names.sort((a, b) => (a === "RAW" ? -1 : b === "RAW" ? 1 : 0));
  return { label: names.join("+"), hasJpeg: formats.includes(1) };
}
