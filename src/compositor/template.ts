import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
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
 * guest's photos go inside it - one photo per slot, in slot order, so the
 * number of slots is also how many shots the kiosk takes per guest. For a 4x6
 * print the cell IS the full sheet, either portrait (1200x1800) or landscape
 * (1800x1200; the compositor turns it onto the portrait sheet).
 * For a 2x6 strip the cell is one strip (2in x 6in); the compositor renders
 * it once and mirrors it twice onto the 4x6 sheet, per the DNP's two-up
 * strip layout. cellWidthPx/cellHeightPx must match the target print size
 * exactly - a mismatched aspect ratio would otherwise get silently squashed
 * by the final resize, so this is validated at load time rather than left to
 * be discovered on a printed sheet.
 */
export const EventTemplateSchema = z.object({
  id: z.string(),
  /** Shown to the operator when picking a layout. Falls back to the id. */
  name: z.string().max(80).optional(),
  printSize: PrintSizeSchema,
  cellWidthPx: z.number().int().positive(),
  cellHeightPx: z.number().int().positive(),
  photoSlots: z.array(PhotoSlotSchema).min(1).max(12),
  overlayFile: z.string().nullable().default(null),
});

export type EventTemplate = z.infer<typeof EventTemplateSchema>;

/**
 * templateId reaches here straight from a client request body (POST
 * /composite). Without this, `${templateId}.json` joined onto templateDir is
 * a path-traversal file-read primitive - a templateId of
 * "../../../../whatever" resolves outside templateDir entirely, since
 * path.join doesn't stop at the root it started from. Templates only ever
 * need a flat, simple name (see assets/templates/*.json), so this rejects
 * anything containing a path separator or "..".
 */
const SAFE_TEMPLATE_ID = /^[A-Za-z0-9_-]+$/;

function assertSafeTemplateId(templateId: string): void {
  if (!SAFE_TEMPLATE_ID.test(templateId)) {
    throw new Error(`Invalid templateId "${templateId}" - must contain only letters, digits, "-" or "_"`);
  }
}

/** Cell sizes a print size may use. 4x6 may be laid out either way round. */
function allowedCellSizes(printSize: EventTemplate["printSize"]): [number, number][] {
  return printSize === "4x6"
    ? [
        [SHEET_WIDTH_PX, SHEET_HEIGHT_PX],
        [SHEET_HEIGHT_PX, SHEET_WIDTH_PX],
      ]
    : [[STRIP_CELL_WIDTH_PX, STRIP_CELL_HEIGHT_PX]];
}

/**
 * Parses and checks a template, whether read from disk or sent by the kiosk's
 * layout editor. Everything that would otherwise only show up as a squashed
 * or cropped print is rejected here instead.
 */
export function validateTemplate(input: unknown): EventTemplate {
  const parsed = EventTemplateSchema.parse(input);
  assertSafeTemplateId(parsed.id);

  const sizes = allowedCellSizes(parsed.printSize);
  if (!sizes.some(([w, h]) => parsed.cellWidthPx === w && parsed.cellHeightPx === h)) {
    throw new Error(
      `Template "${parsed.id}" is for printSize "${parsed.printSize}" and must be ` +
        `${sizes.map(([w, h]) => `${w}x${h}px`).join(" or ")}, but declares ${parsed.cellWidthPx}x${parsed.cellHeightPx}px`
    );
  }

  parsed.photoSlots.forEach((slot, i) => {
    if (slot.x + slot.width > parsed.cellWidthPx || slot.y + slot.height > parsed.cellHeightPx) {
      throw new Error(`Template "${parsed.id}" photo slot ${i + 1} runs off the edge of the cell`);
    }
  });

  return parsed;
}

export function loadTemplate(templateDir: string, templateId: string): EventTemplate {
  assertSafeTemplateId(templateId);
  const filePath = path.join(templateDir, `${templateId}.json`);
  const raw = readFileSync(filePath, "utf-8");
  return validateTemplate(JSON.parse(raw));
}

/** Every loadable template in templateDir. A broken file is skipped, not fatal. */
export function listTemplates(templateDir: string): EventTemplate[] {
  if (!existsSync(templateDir)) return [];
  const out: EventTemplate[] = [];
  for (const file of readdirSync(templateDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(loadTemplate(templateDir, file.slice(0, -".json".length)));
    } catch {
      // A hand-edited file with a typo shouldn't hide every other layout.
    }
  }
  return out.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

export function saveTemplate(templateDir: string, input: unknown): EventTemplate {
  const template = validateTemplate(input);
  // The editor can drop an overlay or keep the one it has, but not point
  // overlayFile at an arbitrary path - that would let a save read any image
  // on disk into the next print.
  const filePath = path.join(templateDir, `${template.id}.json`);
  const current = existsSync(filePath) ? loadTemplate(templateDir, template.id).overlayFile : null;
  const allowedOverlays = [null, current, overlayFileName(template.id)];
  if (!allowedOverlays.includes(template.overlayFile)) {
    throw new Error(`overlayFile must be null, "${overlayFileName(template.id)}" or the template's current overlay`);
  }
  writeFileSync(filePath, JSON.stringify(template, null, 2) + "\n");
  return template;
}

export function deleteTemplate(templateDir: string, templateId: string): void {
  assertSafeTemplateId(templateId);
  unlinkSync(path.join(templateDir, `${templateId}.json`));
  const overlay = path.join(templateDir, overlayFileName(templateId));
  if (existsSync(overlay)) unlinkSync(overlay);
}

/** Overlays uploaded from the kiosk always live at this name, beside the template. */
export function overlayFileName(templateId: string): string {
  return `${templateId}-overlay.png`;
}

export function resolveOverlayPath(templateDir: string, template: EventTemplate): string | null {
  if (!template.overlayFile) return null;
  return path.join(templateDir, template.overlayFile);
}
