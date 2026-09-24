import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  EventTemplate,
  assertImagesAllowed,
  imageFiles,
  loadTemplate,
  pruneAssets,
  saveAsset,
  saveTemplate,
  validateTemplate,
} from "./template";
import { AsyncMutex } from "../util/mutex";

export const LAYOUT_FILE_FORMAT = "kachak-layout";

// The agent is one process, so serializing every save-as-new through one
// mutex makes choosing a free id and saving under it atomic.
const newLayoutLock = new AsyncMutex();

/** One file that carries a layout and every image it uses, to move it to another booth. */
export interface LayoutBundle {
  format: typeof LAYOUT_FILE_FORMAT;
  version: 1;
  template: EventTemplate;
  /** Image bytes as base64, keyed by the file name the template uses. The key is a lookup name, never a path. */
  assets: Record<string, string>;
}

const BundleSchema = z.object({
  format: z.literal(LAYOUT_FILE_FORMAT),
  version: z.literal(1),
  template: z.unknown(),
  assets: z.record(z.string(), z.string()),
});

export async function exportLayout(templateDir: string, templateId: string): Promise<LayoutBundle> {
  const template = loadTemplate(templateDir, templateId);
  const assets: Record<string, string> = {};
  for (const file of imageFiles(template)) {
    assets[file] = (await readFile(path.join(templateDir, file))).toString("base64");
  }
  return { format: LAYOUT_FILE_FORMAT, version: 1, template, assets };
}

/** A template id not used yet, from a display name: `wedding-4-up`, `wedding-4-up-2`, … */
export function freeTemplateId(templateDir: string, name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "layout";
  let id = base;
  for (let n = 2; existsSync(path.join(templateDir, `${id}.json`)); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * Stores `template` as a brand-new layout called `name`: a fresh id, and its
 * images re-saved under that id (asset names belong to one layout). `bytesOf`
 * supplies each referenced image. On failure, images already written are
 * removed again.
 */
async function saveAsNewLayout(
  templateDir: string,
  template: EventTemplate,
  name: string,
  bytesOf: (file: string) => Promise<Buffer>
): Promise<EventTemplate> {
  return newLayoutLock.run(async () => {
    const id = freeTemplateId(templateDir, name);
    try {
      const renamed = new Map<string, string>();
      for (const file of new Set(imageFiles(template))) {
        renamed.set(file, await saveAsset(templateDir, id, await bytesOf(file)));
      }
      return saveTemplate(templateDir, {
        ...template,
        id,
        name,
        elements: template.elements.map((e) => (e.type === "image" ? { ...e, file: renamed.get(e.file)! } : e)),
      });
    } catch (err) {
      pruneAssets(templateDir, id);
      throw err;
    }
  });
}

const MAX_ASSET_BYTES = 10 * 1024 * 1024;

/** Imports a file made by exportLayout as a new layout; never overwrites one. */
export async function importLayout(templateDir: string, bundle: unknown): Promise<EventTemplate> {
  const result = BundleSchema.safeParse(bundle);
  if (!result.success) throw new Error("That file isn't a Kachak layout file.");
  const parsed = result.data;
  const template = validateTemplate(parsed.template);
  for (const file of imageFiles(template)) {
    if (!Object.hasOwn(parsed.assets, file)) throw new Error(`the layout file is missing image "${file}"`);
  }
  return saveAsNewLayout(templateDir, template, template.name ?? template.id, async (file) => {
    const buf = Buffer.from(parsed.assets[file]!, "base64");
    if (buf.length > MAX_ASSET_BYTES) throw new Error(`image "${file}" is larger than 10 MB`);
    return buf;
  });
}

/**
 * "Save as new": stores a draft of layout sourceId (edited or not) as a new
 * layout called `name`, copying the images it uses. The draft may only use
 * images layout sourceId is allowed to use.
 */
export async function copyLayout(templateDir: string, sourceId: string, draft: unknown, name: string): Promise<EventTemplate> {
  const template = validateTemplate({ ...(draft as object), id: sourceId });
  assertImagesAllowed(templateDir, template);
  return saveAsNewLayout(templateDir, template, name, (file) => readFile(path.join(templateDir, file)));
}
