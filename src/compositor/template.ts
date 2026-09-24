import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PrintSizeSchema } from "../config/schema";
import { SHEET_WIDTH_PX, SHEET_HEIGHT_PX, STRIP_CELL_WIDTH_PX, STRIP_CELL_HEIGHT_PX } from "./dimensions";
import { findFont } from "./fonts";

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colours must be #rrggbb");

// Every element is a box in cell pixels. x/y are the top-left of the
// unrotated box and may be negative: anything outside the cell is cropped.
const box = {
  id: z.string().min(1).max(40),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Degrees clockwise about the box centre. */
  rotation: z.number().min(-180).max(180).default(0),
  hidden: z.boolean().default(false),
};

export const LayoutElementSchema = z.discriminatedUnion("type", [
  /** shot is 0-based: which of the guest's photos goes here. */
  z.object({ ...box, type: z.literal("photo"), shot: z.number().int().min(0).max(11) }),
  /** file is one of the layout's uploaded assets, beside the template. */
  z.object({ ...box, type: z.literal("image"), file: z.string().min(1) }),
  z.object({
    ...box,
    type: z.literal("text"),
    text: z.string().max(500),
    font: z.string(),
    /** Pixels, like every other size in the cell. */
    size: z.number().int().min(8).max(600),
    color: Color,
    align: z.enum(["left", "center", "right"]).default("center"),
    bold: z.boolean().default(false),
  }),
  z.object({
    ...box,
    type: z.literal("rect"),
    fill: Color,
    radius: z.number().int().min(0).default(0),
    opacity: z.number().min(0).max(1).default(1),
  }),
]);

export type LayoutElement = z.infer<typeof LayoutElementSchema>;
export type PhotoElement = Extract<LayoutElement, { type: "photo" }>;
export type TextElement = Extract<LayoutElement, { type: "text" }>;

/**
 * A template describes one printable "cell": its pixel size, a background
 * colour and the elements drawn on it. elements is in layer order, first at
 * the bottom. Each photo element takes one of the guest's shots, so the
 * highest shot number + 1 is how many photos the kiosk takes per guest. For a
 * 4x6 print the cell IS the full sheet, either portrait (1200x1800) or
 * landscape (1800x1200; the compositor turns it onto the portrait sheet).
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
  background: Color.default("#ffffff"),
  elements: z.array(LayoutElementSchema).min(1).max(40),
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

export function assertSafeTemplateId(templateId: string): void {
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

const LegacyFieldsSchema = z.object({
  photoSlots: z
    .array(
      z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
    )
    .min(1)
    .max(12),
  overlayFile: z.string().nullable().default(null),
});

/**
 * Converts the pre-elements format (photoSlots + overlayFile): each slot
 * becomes a photo taking that shot, and the overlay a full-cell image on top.
 * Anything carrying photoSlots counts as legacy even if it also has elements:
 * until the kiosk editor is rewritten, it sends back what GET /templates gave
 * it (elements plus the derived photoSlots) with only photoSlots edited, and
 * before then no layout has anything but photos and an overlay.
 */
export function migrateLegacyTemplate(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("photoSlots" in input)) return input;
  const { photoSlots, overlayFile } = LegacyFieldsSchema.parse(input);
  const rest: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  delete rest["photoSlots"];
  delete rest["overlayFile"];
  delete rest["elements"];
  const elements: unknown[] = photoSlots.map((slot, i) => ({ id: `photo-${i + 1}`, type: "photo", shot: i, ...slot }));
  if (overlayFile) {
    elements.push({
      id: "overlay",
      type: "image",
      file: overlayFile,
      x: 0,
      y: 0,
      width: rest["cellWidthPx"],
      height: rest["cellHeightPx"],
    });
  }
  return { ...rest, elements };
}

/** How many photos a guest takes: the highest shot number + 1. */
export function shotCount(t: EventTemplate): number {
  return Math.max(0, ...t.elements.map((e) => (e.type === "photo" ? e.shot + 1 : 0)));
}

export function imageFiles(t: EventTemplate): string[] {
  return t.elements.flatMap((e) => (e.type === "image" ? [e.file] : []));
}

/**
 * Uploaded images are named by the agent, never the client:
 * `<templateId>-<letters/digits>.png|jpg`, beside the template. The suffix
 * has no "-", so one layout's assets never match another layout's pattern.
 * templateId must already have passed assertSafeTemplateId.
 */
export function isOwnAsset(templateId: string, file: string): boolean {
  return new RegExp(`^${templateId}-[A-Za-z0-9]+\\.(png|jpg)$`).test(file);
}

/**
 * Parses and checks a template, whether read from disk or sent by the kiosk's
 * layout editor, in the old or new format. Everything that would otherwise
 * only show up as a wrong or failed print is rejected here instead.
 */
export function validateTemplate(input: unknown): EventTemplate {
  const parsed = EventTemplateSchema.parse(migrateLegacyTemplate(input));
  assertSafeTemplateId(parsed.id);

  const sizes = allowedCellSizes(parsed.printSize);
  if (!sizes.some(([w, h]) => parsed.cellWidthPx === w && parsed.cellHeightPx === h)) {
    throw new Error(
      `Template "${parsed.id}" is for printSize "${parsed.printSize}" and must be ` +
        `${sizes.map(([w, h]) => `${w}x${h}px`).join(" or ")}, but declares ${parsed.cellWidthPx}x${parsed.cellHeightPx}px`
    );
  }

  const ids = new Set<string>();
  for (const el of parsed.elements) {
    if (ids.has(el.id)) throw new Error(`Template "${parsed.id}" has two elements with id "${el.id}"`);
    ids.add(el.id);
    if (el.type === "text" && !findFont(el.font)) {
      throw new Error(`Template "${parsed.id}" uses unknown font "${el.font}"`);
    }
  }

  const shots = new Set(parsed.elements.flatMap((e) => (e.type === "photo" ? [e.shot] : [])));
  if (shots.size === 0) throw new Error(`Template "${parsed.id}" needs at least one photo`);
  const count = Math.max(...shots) + 1;
  if (shots.size !== count) {
    throw new Error(`Template "${parsed.id}" skips a photo - photos must run 1 to ${count} with none missing`);
  }

  return parsed;
}

export interface LegacySlot {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ApiTemplate = EventTemplate & { photoSlots: LegacySlot[]; overlayFile: string | null };

/**
 * Adds the old fields the current kiosk still reads: one slot per shot (its
 * first photo element) and the overlay (a full-cell image on top). Remove
 * once the kiosk editor works on elements (layout elements PR 2).
 */
export function withLegacyFields(t: EventTemplate): ApiTemplate {
  const photos = t.elements.filter((e): e is PhotoElement => e.type === "photo");
  const photoSlots = Array.from({ length: shotCount(t) }, (_, shot) => {
    const { x, y, width, height } = photos.find((p) => p.shot === shot)!;
    return { x, y, width, height };
  });
  const top = t.elements[t.elements.length - 1];
  const overlayFile =
    top?.type === "image" && top.x === 0 && top.y === 0 && top.width === t.cellWidthPx && top.height === t.cellHeightPx
      ? top.file
      : null;
  return { ...t, photoSlots, overlayFile };
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
  // An image may be one of this layout's uploads, or a file the layout on
  // disk already uses (a hand-placed overlay) - never an arbitrary path,
  // which would let a save read any image on disk into the next print.
  const filePath = path.join(templateDir, `${template.id}.json`);
  let current: string[] = [];
  try {
    current = existsSync(filePath) ? imageFiles(loadTemplate(templateDir, template.id)) : [];
  } catch {
    // A broken file on disk can still be overwritten; it just grants nothing.
  }
  for (const file of imageFiles(template)) {
    if (!isOwnAsset(template.id, file) && !current.includes(file)) {
      throw new Error(`image "${file}" doesn't belong to layout ${template.id} - upload it again`);
    }
    if (!existsSync(path.join(templateDir, file))) {
      throw new Error(`image "${file}" is missing - upload it again`);
    }
  }
  writeFileSync(filePath, JSON.stringify(template, null, 2) + "\n");
  return template;
}

export function deleteTemplate(templateDir: string, templateId: string): void {
  assertSafeTemplateId(templateId);
  unlinkSync(path.join(templateDir, `${templateId}.json`));
}
