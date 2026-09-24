import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import sharp from "sharp";
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
  width: z.number().int().positive().max(3600),
  height: z.number().int().positive().max(3600),
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
 * Anything carrying photoSlots counts as legacy, even alongside elements:
 * that was the shape the pre-elements kiosk sent back.
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
  pruneAssets(templateDir, template.id);
  return template;
}

export function deleteTemplate(templateDir: string, templateId: string): void {
  assertSafeTemplateId(templateId);
  unlinkSync(path.join(templateDir, `${templateId}.json`));
  pruneAssets(templateDir, templateId);
}

/** Stores an uploaded PNG/JPEG for a layout under an agent-chosen name and returns that name. */
export async function saveAsset(templateDir: string, templateId: string, body: unknown): Promise<string> {
  assertSafeTemplateId(templateId);
  if (!Buffer.isBuffer(body) || body.length === 0) throw new Error("send the image as a PNG or JPEG body");
  const format = await sharp(body)
    .metadata()
    .then((m) => m.format, () => null);
  const ext = format === "png" ? "png" : format === "jpeg" ? "jpg" : null;
  if (!ext) throw new Error("image must be a PNG or JPEG");
  const file = `${templateId}-${randomBytes(6).toString("hex")}.${ext}`;
  await writeFile(path.join(templateDir, file), body);
  return file;
}

/** Where one of a layout's images lives: its own upload, or a file the layout already uses. */
export function assetPath(templateDir: string, templateId: string, file: string): string {
  assertSafeTemplateId(templateId);
  let used: string[] = [];
  try {
    used = imageFiles(loadTemplate(templateDir, templateId));
  } catch {
    // Not saved yet: only its own uploads can be shown.
  }
  if (!isOwnAsset(templateId, file) && !used.includes(file)) {
    throw new Error(`no image "${file}" in layout ${templateId}`);
  }
  return path.join(templateDir, file);
}

/**
 * Deletes the layout's uploads that no layout references any more. Checking
 * every layout, not just this one, keeps a hand-edited layout's image safe
 * even if its name looks like one of this layout's uploads.
 */
export function pruneAssets(templateDir: string, templateId: string): void {
  const used = new Set(listTemplates(templateDir).flatMap(imageFiles));
  for (const file of readdirSync(templateDir)) {
    if (isOwnAsset(templateId, file) && !used.has(file)) {
      // Best-effort: this runs after saveTemplate/deleteTemplate already
      // wrote or removed the JSON, so the save/delete has already succeeded.
      // On Windows, unlinkSync can throw EPERM while the file is still held
      // open elsewhere. An orphan image left behind is harmless; reporting a
      // save as failed after it actually succeeded is not, so one failing
      // unlink must neither abort the rest of the prune nor throw.
      try {
        unlinkSync(path.join(templateDir, file));
      } catch {
        // Leave it; it'll be swept up next time this layout (or any other) is saved or deleted.
      }
    }
  }
}
