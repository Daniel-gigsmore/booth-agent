import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PrintSizeSchema } from "../config/schema";
import { SHEET_WIDTH_PX, SHEET_HEIGHT_PX, STRIP_CELL_WIDTH_PX, STRIP_CELL_HEIGHT_PX } from "./dimensions";

const PhotoSlotSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/**
 * A template describes one printable "cell": its pixel size and where the
 * guest's photo(s) go inside it. For a 4x6 print the cell IS the full sheet.
 * For a 2x6 strip the cell is one strip (2in x 6in); the compositor renders
 * it once and mirrors it twice onto the 4x6 sheet, per the DNP's two-up
 * strip layout. cellWidthPx/cellHeightPx must match the target print size
 * exactly - a mismatched aspect ratio would otherwise get silently squashed
 * by the final resize, so this is validated at load time rather than left to
 * be discovered on a printed sheet.
 */
export const EventTemplateSchema = z.object({
  id: z.string(),
  printSize: PrintSizeSchema,
  cellWidthPx: z.number().int().positive(),
  cellHeightPx: z.number().int().positive(),
  photoSlots: z.array(PhotoSlotSchema).min(1),
  overlayFile: z.string().nullable().default(null),
});

export type EventTemplate = z.infer<typeof EventTemplateSchema>;

export function loadTemplate(templateDir: string, templateId: string): EventTemplate {
  const filePath = path.join(templateDir, `${templateId}.json`);
  const raw = readFileSync(filePath, "utf-8");
  const parsed = EventTemplateSchema.parse(JSON.parse(raw));

  const [expectedWidth, expectedHeight] =
    parsed.printSize === "4x6"
      ? [SHEET_WIDTH_PX, SHEET_HEIGHT_PX]
      : [STRIP_CELL_WIDTH_PX, STRIP_CELL_HEIGHT_PX];
  if (parsed.cellWidthPx !== expectedWidth || parsed.cellHeightPx !== expectedHeight) {
    throw new Error(
      `Template "${templateId}" is for printSize "${parsed.printSize}" and must be ` +
        `${expectedWidth}x${expectedHeight}px, but declares ${parsed.cellWidthPx}x${parsed.cellHeightPx}px`
    );
  }

  return parsed;
}

export function resolveOverlayPath(templateDir: string, template: EventTemplate): string | null {
  if (!template.overlayFile) return null;
  return path.join(templateDir, template.overlayFile);
}
