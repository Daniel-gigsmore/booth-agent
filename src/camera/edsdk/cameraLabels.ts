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

const FORMAT_NAMES: Record<number, string> = { 1: "JPEG", 2: "RAW", 4: "RAW", 6: "RAW", 8: "HEIF" };

/** 0xFFFFFFFF is how EDSDK says "on AC power"; 0-100 is a percentage. */
export function batteryLevel(raw: number): number | "ac" | null {
  if (raw >>> 0 === 0xffffffff) return "ac";
  return raw >= 0 && raw <= 100 ? raw : null;
}

export const aeModeLabel = (raw: number): string => AE_MODES[raw] ?? hexCode(raw);
export const afModeLabel = (raw: number): string => AF_MODES[raw] ?? hexCode(raw);

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

export type SettingKey = "iso" | "av" | "tv" | "wb" | "ev" | "quality";

// Canon EDSDK code tables (EDSDK API reference, "Property Data").
const ISO: Record<number, string> = {
  0x00: "Auto", 0x28: "6", 0x30: "12", 0x38: "25", 0x40: "50", 0x48: "100", 0x4b: "125", 0x4d: "160", 0x50: "200",
  0x53: "250", 0x55: "320", 0x58: "400", 0x5b: "500", 0x5d: "640", 0x60: "800", 0x63: "1000", 0x65: "1250",
  0x68: "1600", 0x6b: "2000", 0x6d: "2500", 0x70: "3200", 0x73: "4000", 0x75: "5000", 0x78: "6400", 0x7b: "8000",
  0x7d: "10000", 0x80: "12800", 0x83: "16000", 0x85: "20000", 0x88: "25600", 0x8b: "32000", 0x8d: "40000",
  0x90: "51200", 0x98: "102400",
};

const AV: Record<number, string> = {
  0x08: "1", 0x0b: "1.1", 0x0c: "1.2", 0x0d: "1.2", 0x10: "1.4", 0x13: "1.6", 0x14: "1.8", 0x15: "1.8", 0x18: "2",
  0x1b: "2.2", 0x1c: "2.5", 0x1d: "2.5", 0x20: "2.8", 0x23: "3.2", 0x24: "3.5", 0x25: "3.5", 0x28: "4", 0x2b: "4.5",
  0x2c: "4.5", 0x2d: "5", 0x30: "5.6", 0x33: "6.3", 0x34: "6.7", 0x35: "7.1", 0x38: "8", 0x3b: "9", 0x3c: "9.5",
  0x3d: "10", 0x40: "11", 0x43: "13", 0x44: "13", 0x45: "14", 0x48: "16", 0x4b: "18", 0x4c: "19", 0x4d: "20",
  0x50: "22", 0x53: "25", 0x54: "27", 0x55: "29", 0x58: "32", 0x5b: "36", 0x5c: "38", 0x5d: "40", 0x60: "45",
  0x63: "51", 0x64: "54", 0x65: "57", 0x68: "64", 0x6b: "72", 0x6c: "76", 0x6d: "80", 0x70: "91",
};

const TV: Record<number, string> = {
  0x0c: "Bulb", 0x10: '30"', 0x13: '25"', 0x14: '20"', 0x15: '20"', 0x18: '15"', 0x1b: '13"', 0x1c: '10"',
  0x1d: '10"', 0x20: '8"', 0x23: '6"', 0x24: '6"', 0x25: '5"', 0x28: '4"', 0x2b: '3"2', 0x2c: '3"', 0x2d: '2"5',
  0x30: '2"', 0x33: '1"6', 0x34: '1"5', 0x35: '1"3', 0x38: '1"', 0x3b: '0"8', 0x3c: '0"7', 0x3d: '0"6',
  0x40: '0"5', 0x43: '0"4', 0x44: '0"3', 0x45: '0"3', 0x48: "1/4", 0x4b: "1/5", 0x4c: "1/6", 0x4d: "1/6",
  0x50: "1/8", 0x53: "1/10", 0x54: "1/10", 0x55: "1/13", 0x58: "1/15", 0x5b: "1/20", 0x5c: "1/20", 0x5d: "1/25",
  0x60: "1/30", 0x63: "1/40", 0x64: "1/45", 0x65: "1/50", 0x68: "1/60", 0x6b: "1/80", 0x6c: "1/90",
  0x6d: "1/100", 0x70: "1/125", 0x73: "1/160", 0x74: "1/180", 0x75: "1/200", 0x78: "1/250", 0x7b: "1/320",
  0x7c: "1/350", 0x7d: "1/400", 0x80: "1/500", 0x83: "1/640", 0x84: "1/750", 0x85: "1/800", 0x88: "1/1000",
  0x8b: "1/1250", 0x8c: "1/1500", 0x8d: "1/1600", 0x90: "1/2000", 0x93: "1/2500", 0x94: "1/3000",
  0x95: "1/3200", 0x98: "1/4000", 0x9b: "1/5000", 0x9c: "1/6000", 0x9d: "1/6400", 0xa0: "1/8000",
};

const WB: Record<number, string> = {
  0: "Auto (ambience)", 23: "Auto (white)", 1: "Daylight", 2: "Cloudy", 3: "Tungsten",
  4: "Fluorescent", 5: "Flash", 6: "Custom", 8: "Shade", 9: "Colour temperature",
};

/** EDSDK stores exposure compensation as a signed byte in eighths of a stop: 3 = 1/3, 4 = 1/2, 5 = 2/3. */
function evLabel(code: number): string {
  const byte = code & 0xff;
  const signed = byte > 127 ? byte - 256 : byte;
  if (signed === 0) return "0";
  const eighths = Math.abs(signed);
  const whole = Math.floor(eighths / 8);
  const frac = ({ 0: "", 3: "1/3", 4: "1/2", 5: "2/3" } as Record<number, string>)[eighths % 8];
  if (frac === undefined) return hexCode(code);
  return `${signed < 0 ? "-" : "+"}${[whole || "", frac].filter(Boolean).join(" ")}`;
}

const SIZE: Record<number, string> = { 0: "L", 1: "M", 2: "S", 5: "M1", 6: "M2", 0xe: "S1", 0xf: "S2", 0x10: "S3" };
const COMPRESS: Record<number, string> = { 2: "Normal", 3: "Fine", 5: "Super Fine" };
const RAW_SIZE: Record<number, string> = { 0: "RAW", 1: "M-RAW", 2: "S-RAW" };

/** One image of the pair: RAW sizes have their own names; JPEG/HEIF read as "<size> <format> <compression>". */
function imagePart(size: number, format: number, compress: number): string {
  if (format === 2 || format === 4 || format === 6) return RAW_SIZE[size] ?? "RAW";
  const name = FORMAT_NAMES[format] ?? hexCode(format);
  return [SIZE[size] ?? hexCode(size), name, COMPRESS[compress]].filter(Boolean).join(" ");
}

/** Full label for a quality option, e.g. 0x00640013 = "RAW + L JPEG Fine". */
export function qualityLabel(raw: number): string {
  const parts: string[] = [];
  const primaryFormat = (raw >>> 20) & 0xf;
  const secondaryFormat = (raw >>> 4) & 0xf;
  if (primaryFormat) parts.push(imagePart((raw >>> 24) & 0xff, primaryFormat, (raw >>> 16) & 0xf));
  if (secondaryFormat) parts.push(imagePart((raw >>> 8) & 0xff, secondaryFormat, raw & 0xf));
  return parts.join(" + ") || hexCode(raw);
}

export function settingLabel(key: SettingKey, code: number): string {
  switch (key) {
    case "iso": return ISO[code] !== undefined ? `ISO ${ISO[code]}` : hexCode(code);
    case "av": return AV[code] !== undefined ? `f/${AV[code]}` : hexCode(code);
    case "tv": return TV[code] ?? hexCode(code);
    case "wb": return WB[code] ?? hexCode(code);
    case "ev": return evLabel(code);
    case "quality": return qualityLabel(code);
  }
}
