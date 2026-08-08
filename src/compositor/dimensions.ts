/**
 * Physical print geometry at 300dpi. The DNP DS-RX1HS media is a 4in x 6in
 * sheet used in two ways: as one full-bleed 4x6 photo, or as two 2in x 6in
 * strips printed side by side ("two-up") on that same sheet. Both modes
 * therefore share the same final canvas size - only what's drawn inside
 * differs - which is why the compositor always renders to SHEET_WIDTH_PX x
 * SHEET_HEIGHT_PX regardless of print size.
 */
export const DPI = 300;
export const SHEET_WIDTH_IN = 4;
export const SHEET_HEIGHT_IN = 6;
export const SHEET_WIDTH_PX = SHEET_WIDTH_IN * DPI; // 1200
export const SHEET_HEIGHT_PX = SHEET_HEIGHT_IN * DPI; // 1800

export const STRIP_CELL_WIDTH_PX = SHEET_WIDTH_PX / 2; // 600 (2in strip)
export const STRIP_CELL_HEIGHT_PX = SHEET_HEIGHT_PX; // 1800 (6in strip)
