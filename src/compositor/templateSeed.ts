import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

/** The layouts that ship with the agent (README: default-4r-grid, default-4r-three, default, default-strip). */
export const BUNDLED_TEMPLATE_DIR = path.join(__dirname, "..", "..", "assets", "templates");

/**
 * Makes sure compositing.templateDir exists and, when it holds no layouts at
 * all, fills it with the bundled ones.
 *
 * A fresh booth used to need this done by hand ("copy assets/templates/*.json
 * here on setup"). Skipping it left the layout editor failing every Save with
 * ENOENT and the booth with no layout to print, so the agent does it itself.
 * Only an empty folder is seeded: a bundled layout the operator deleted on
 * purpose must not come back at the next restart.
 */
export function ensureTemplateDir(dir: string, bundledDir: string = BUNDLED_TEMPLATE_DIR): { created: boolean; seeded: string[] } {
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  const seeded: string[] = [];
  if (readdirSync(dir).some((f) => f.toLowerCase().endsWith(".json"))) return { created, seeded };
  if (!existsSync(bundledDir)) return { created, seeded };
  for (const file of readdirSync(bundledDir)) {
    if (!file.toLowerCase().endsWith(".json")) continue;
    copyFileSync(path.join(bundledDir, file), path.join(dir, file));
    seeded.push(file);
  }
  return { created, seeded };
}
