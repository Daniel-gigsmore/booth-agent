# Layout Elements PR 1 (agent) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make booth-agent store layouts as an ordered list of elements (photo, image, text, rect) and render them at composite time, while the current kiosk keeps working unchanged.

**Architecture:** `src/compositor/template.ts` gets the new zod schema, validation, legacy migration (`photoSlots` + `overlayFile` → `elements`), a derived legacy view for the current kiosk, and on-disk asset handling. `src/compositor/compositor.ts` renders each visible element to its own box, rotates it about its centre, crops it to the cell, and composites in array order over the background colour. New small modules hold the bundled fonts (`fonts.ts`) and the per-print text variables (`variables.ts`). Routes stay thin.

**Tech Stack:** TypeScript 5 (strict, `noUnusedLocals`), Node 22+, Express 4, zod 3, sharp 0.35 (libvips 8.18 with Pango 1.58 for text), vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-24-layout-elements-design.md` (PR 1 = sections 1 and 2).

## Global Constraints

- The current kiosk (`C:\BoothAgent\kiosk`, reads `template.photoSlots`, sends `photoSlots`/`overlayFile` back, uploads to `POST /templates/:id/overlay`, shows `GET /templates/:id/overlay`) must keep working after this PR is deployed.
- Array order is layer order; the first element is the bottom layer.
- Colours are `#rrggbb`. At most 40 elements. 1 to 12 shots; shots 0..n-1 all present. Text at most 500 characters. `font` must be a bundled font.
- An `image.file` may only be one of the layout's own uploads (`<templateId>-<letters/digits>.png|jpg`) or a file the layout on disk already references. Never an arbitrary path.
- Text variables: `{event}` (config `event.name`, falling back to `event.id`), `{date}` like `24 Sep 2026`, `{time}` like `14:05` (local time), `{code}` = first 8 characters of the first shot's captureId. Unknown `{...}` prints as typed.
- Fonts: Manrope, Bricolage Grotesque, Playfair Display, Great Vibes (OFL, from github.com/google/fonts).
- Everything stays GET/POST (CORS allowlist in `src/server/cors.ts`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run all commands from `C:\Users\User\Documents\booth-agent`, on branch `feat/layout-elements`.

## Verified facts (spiked 2026-09-24, don't re-derive)

- Pango font descriptions like `"Manrope Bold 64px"` work with a variable TTF passed as `fontfile`: `Bold` selects the 700 weight (about 29% more ink), and `px` sizes are in pixels.
- sharp's text output is trimmed to the text's own extent (asking for `width: 1000` gave a 646 px wide image), so the renderer must place text inside its box itself.
- `composite()` accepts negative and overhanging offsets, but throws `Image to composite must have same dimensions or smaller` when the overlay is larger than the canvas. So the renderer always crops to the canvas first.
- `rotate(angle, { background: transparent })` expands to the rotated bounding box (100x50 at 30° gives 112x93).
- Node 24's `en-GB` short month for September is `"Sept"`, so `{date}` uses an explicit month list.

## File Structure

| File | Responsibility |
|---|---|
| `assets/fonts/*.ttf`, `assets/fonts/OFL-*.txt` | Bundled fonts and their licences |
| `src/compositor/fonts.ts` (new) | Font registry: families, files, path lookup |
| `src/compositor/variables.ts` (new) | Build and fill `{event}` `{date}` `{time}` `{code}` |
| `src/compositor/template.ts` (rewrite) | Schema, validation, migration, legacy view, load/list/save/delete, assets on disk |
| `src/compositor/compositor.ts` (rewrite of `renderCell`) | Element rendering, rotation, cropping |
| `src/server/routes.ts` | Wire variables, asset and font endpoints, legacy view, overlay compat |
| `src/config/schema.ts`, `booth.config.example.json`, `README.md` | `event.name`, docs |
| `tests/fonts.test.ts`, `tests/variables.test.ts`, `tests/template.test.ts`, `tests/template.assets.test.ts`, `tests/compositor.elements.test.ts`, `tests/templates.routes.test.ts` | Tests |

---

### Task 1: Bundled fonts and text variables

**Files:**
- Create: `assets/fonts/Manrope.ttf`, `assets/fonts/BricolageGrotesque.ttf`, `assets/fonts/PlayfairDisplay.ttf`, `assets/fonts/GreatVibes.ttf`, `assets/fonts/OFL-Manrope.txt`, `assets/fonts/OFL-BricolageGrotesque.txt`, `assets/fonts/OFL-PlayfairDisplay.txt`, `assets/fonts/OFL-GreatVibes.txt`
- Create: `src/compositor/fonts.ts`, `src/compositor/variables.ts`
- Test: `tests/fonts.test.ts`, `tests/variables.test.ts`

**Interfaces:**
- Produces: `interface BundledFont { family: string; file: string; hasBold: boolean }`, `FONT_DIR: string`, `FONTS: readonly BundledFont[]`, `findFont(family: string): BundledFont | undefined`, `fontFilePath(file: string): string | null`
- Produces: `interface TextVariables { event: string; date: string; time: string; code: string }`, `textVariables(eventName: string, captureId: string, now?: Date): TextVariables`, `fillVariables(text: string, vars: TextVariables): string`

- [ ] **Step 1: Download the fonts**

The user must approve this download first (4 fonts, about 1.3 MB in total, from raw.githubusercontent.com/google/fonts).

```bash
mkdir -p assets/fonts && cd assets/fonts
B=https://raw.githubusercontent.com/google/fonts/main/ofl
curl -fsSL -o Manrope.ttf "$B/manrope/Manrope%5Bwght%5D.ttf"
curl -fsSL -o BricolageGrotesque.ttf "$B/bricolagegrotesque/BricolageGrotesque%5Bopsz,wdth,wght%5D.ttf"
curl -fsSL -o PlayfairDisplay.ttf "$B/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf"
curl -fsSL -o GreatVibes.ttf "$B/greatvibes/GreatVibes-Regular.ttf"
curl -fsSL -o OFL-Manrope.txt "$B/manrope/OFL.txt"
curl -fsSL -o OFL-BricolageGrotesque.txt "$B/bricolagegrotesque/OFL.txt"
curl -fsSL -o OFL-PlayfairDisplay.txt "$B/playfairdisplay/OFL.txt"
curl -fsSL -o OFL-GreatVibes.txt "$B/greatvibes/OFL.txt"
ls -la
```

Expected sizes: 164700, 408496, 300724 and 457588 bytes for the TTFs.

- [ ] **Step 2: Write the failing tests**

`tests/fonts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { FONTS, FONT_DIR, findFont, fontFilePath } from "../src/compositor/fonts";

async function ink(font: string, fontfile: string): Promise<number> {
  const { data } = await sharp({
    text: { text: '<span foreground="#000000">Gigsmore 2026</span>', font, fontfile, rgba: true },
  })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 3; i < data.length; i += 4) sum += data[i]!;
  return sum;
}

describe("bundled fonts", () => {
  it.each(FONTS.map((f) => [f.family, f] as const))("%s is on disk and renders", async (_family, font) => {
    const file = path.join(FONT_DIR, font.file);
    expect(existsSync(file)).toBe(true);
    const regular = await ink(`${font.family} 48px`, file);
    expect(regular).toBeGreaterThan(0);
    if (font.hasBold) expect(await ink(`${font.family} Bold 48px`, file)).toBeGreaterThan(regular * 1.1);
  });

  it("finds fonts by family", () => {
    expect(findFont("Manrope")?.file).toBe("Manrope.ttf");
    expect(findFont("Comic Sans")).toBeUndefined();
  });

  it("only resolves bundled font files", () => {
    expect(fontFilePath("Manrope.ttf")).toBe(path.join(FONT_DIR, "Manrope.ttf"));
    expect(fontFilePath("../../booth.config.json")).toBeNull();
    expect(fontFilePath("OFL-Manrope.txt")).toBeNull();
  });
});
```

`tests/variables.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { textVariables, fillVariables } from "../src/compositor/variables";

describe("text variables", () => {
  const now = new Date(2026, 8, 4, 9, 5); // local time, 4 Sep 2026 09:05
  const vars = textVariables("Gigsmore Launch", "e2e116bb-2acc-4c7f-b260-c73801a2449b", now);

  it("formats each variable", () => {
    expect(vars).toEqual({ event: "Gigsmore Launch", date: "4 Sep 2026", time: "09:05", code: "e2e116bb" });
  });

  it("fills known variables and leaves anything else as typed", () => {
    expect(fillVariables("{event} · {date} {time} #{code} {nope} {", vars)).toBe(
      "Gigsmore Launch · 4 Sep 2026 09:05 #e2e116bb {nope} {"
    );
  });
});
```

- [ ] **Step 3: Run the tests and check they fail**

Run: `npx vitest run tests/fonts.test.ts tests/variables.test.ts`
Expected: FAIL, because `../src/compositor/fonts` and `../src/compositor/variables` can't be resolved.

- [ ] **Step 4: Implement**

`src/compositor/fonts.ts`:

```ts
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
```

`src/compositor/variables.ts`:

```ts
/** Values a layout's text can include as {event}, {date}, {time} and {code}; filled in per print. */
export interface TextVariables {
  event: string;
  date: string;
  time: string;
  code: string;
}

// Spelled out: Node's en-GB short month for September is "Sept".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

export function textVariables(eventName: string, captureId: string, now: Date = new Date()): TextVariables {
  return {
    event: eventName,
    date: `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    code: captureId.slice(0, 8),
  };
}

export function fillVariables(text: string, vars: TextVariables): string {
  return text.replace(/\{(event|date|time|code)\}/g, (_match, name: keyof TextVariables) => vars[name]);
}
```

- [ ] **Step 5: Run the tests and check they pass**

Run: `npx vitest run tests/fonts.test.ts tests/variables.test.ts`
Expected: PASS, 8 tests (4 per-font + 2 lookup in `fonts.test.ts`, 2 in `variables.test.ts`). If a `hasBold` font fails the bold check, set its `hasBold` to `false` and note it in the commit message. Don't change the test threshold.

- [ ] **Step 6: Commit**

```bash
git add assets/fonts src/compositor/fonts.ts src/compositor/variables.ts tests/fonts.test.ts tests/variables.test.ts
git commit -m "feat: bundled fonts and per-print text variables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Element schema, validation, migration and legacy view

**Files:**
- Modify: `src/compositor/template.ts` (schema and `validateTemplate` rewritten; `load/list` unchanged; `saveTemplate` image check; `overlayFileName` and `resolveOverlayPath` removed)
- Modify: `tests/template.test.ts`

**Interfaces:**
- Consumes: `findFont` from Task 1.
- Produces (all exported from `src/compositor/template.ts`):
  - `LayoutElementSchema`, `type LayoutElement`, `type PhotoElement = Extract<LayoutElement, { type: "photo" }>`, `type TextElement = Extract<LayoutElement, { type: "text" }>`
  - `EventTemplateSchema`, `type EventTemplate` (fields: `id, name?, printSize, cellWidthPx, cellHeightPx, background, elements`)
  - `migrateLegacyTemplate(input: unknown): unknown`
  - `validateTemplate(input: unknown): EventTemplate` (accepts the old and new formats)
  - `shotCount(t: EventTemplate): number`
  - `imageFiles(t: EventTemplate): string[]`
  - `isOwnAsset(templateId: string, file: string): boolean`
  - `interface LegacySlot { x; y; width; height }`, `type ApiTemplate = EventTemplate & { photoSlots: LegacySlot[]; overlayFile: string | null }`, `withLegacyFields(t: EventTemplate): ApiTemplate`
  - `assertSafeTemplateId(templateId: string): void` (now exported)
  - unchanged: `loadTemplate`, `listTemplates`; `saveTemplate(templateDir, input): EventTemplate`; `deleteTemplate(templateDir, templateId): void`

The compositor and routes stop compiling after this task because `resolveOverlayPath` and `photoSlots` go away. That is expected. Tasks 4 and 5 fix them. In this task, run only the template tests, not `typecheck`.

- [ ] **Step 1: Rewrite the tests**

Replace `tests/template.test.ts` with the following. It keeps the existing templateId safety tests unchanged and replaces the `saveTemplate (layout editor)` block.

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadTemplate,
  saveTemplate,
  listTemplates,
  validateTemplate,
  withLegacyFields,
  shotCount,
  isOwnAsset,
} from "../src/compositor/template";
import { SHEET_WIDTH_PX, SHEET_HEIGHT_PX } from "../src/compositor/dimensions";

let templateDir: string;
let outsideSecret: string;

beforeEach(async () => {
  // templateDir and a sibling directory outside it - a successful traversal
  // would read outsideSecret via "../<outside-dir-name>/secret".
  const root = await mkdtemp(path.join(tmpdir(), "booth-template-"));
  templateDir = path.join(root, "templates");
  await mkdir(templateDir, { recursive: true });

  const outsideDir = path.join(root, "outside");
  await mkdir(outsideDir, { recursive: true });
  outsideSecret = path.join(outsideDir, "secret.json");
  await writeFile(outsideSecret, JSON.stringify({ leaked: true }));

  await writeFile(
    path.join(templateDir, "default.json"),
    JSON.stringify({
      id: "default",
      printSize: "4x6",
      cellWidthPx: SHEET_WIDTH_PX,
      cellHeightPx: SHEET_HEIGHT_PX,
      photoSlots: [{ x: 0, y: 0, width: SHEET_WIDTH_PX, height: SHEET_HEIGHT_PX }],
      overlayFile: null,
    })
  );
});

afterEach(async () => {
  await rm(path.dirname(templateDir), { recursive: true, force: true });
});

describe("loadTemplate templateId safety", () => {
  it("loads a legitimate flat templateId", () => {
    const template = loadTemplate(templateDir, "default");
    expect(template.id).toBe("default");
  });

  it("rejects a templateId that traverses out of templateDir before touching the filesystem", () => {
    const traversal = path.relative(templateDir, outsideSecret).replace(/\.json$/, "").replace(/\\/g, "/");
    expect(() => loadTemplate(templateDir, traversal)).toThrow(/Invalid templateId/);
  });

  it("rejects an absolute path used as templateId", () => {
    expect(() => loadTemplate(templateDir, outsideSecret.replace(/\.json$/, ""))).toThrow(/Invalid templateId/);
  });

  it("rejects a templateId containing a path separator even if it stays inside templateDir", () => {
    expect(() => loadTemplate(templateDir, "sub/default")).toThrow(/Invalid templateId/);
  });
});

const landscape = {
  id: "my-grid",
  name: "My grid",
  printSize: "4x6",
  cellWidthPx: SHEET_HEIGHT_PX,
  cellHeightPx: SHEET_WIDTH_PX,
  background: "#fbf8f3",
  elements: [
    { id: "p1", type: "photo", shot: 0, x: 60, y: 60, width: 810, height: 540 },
    { id: "p2", type: "photo", shot: 1, x: 930, y: 60, width: 810, height: 540 },
    { id: "t1", type: "text", text: "{event}", font: "Manrope", size: 64, color: "#222222", x: 60, y: 700, width: 1680, height: 120 },
    { id: "r1", type: "rect", fill: "#f26b3a", x: 0, y: 1100, width: 1800, height: 100 },
  ],
};

describe("element templates", () => {
  it("fills in defaults and counts shots", () => {
    const t = validateTemplate(landscape);
    expect(t.elements[0]).toMatchObject({ rotation: 0, hidden: false });
    expect(t.elements[2]).toMatchObject({ align: "center", bold: false });
    expect(t.elements[3]).toMatchObject({ radius: 0, opacity: 1 });
    expect(shotCount(t)).toBe(2);
  });

  it("lets the same shot appear twice and elements run past the edge", () => {
    const t = validateTemplate({
      ...landscape,
      elements: [...landscape.elements, { id: "p3", type: "photo", shot: 0, x: -50, y: -50, width: 3000, height: 200 }],
    });
    expect(shotCount(t)).toBe(2);
  });

  it.each([
    ["no photo", { elements: [landscape.elements[3]] }, /at least one photo/],
    ["a gap in the shots", { elements: [{ ...landscape.elements[0], shot: 1 }] }, /skips a photo/],
    ["a bad colour", { background: "red" }, /#rrggbb/],
    ["an unknown font", { elements: [landscape.elements[0], { ...landscape.elements[2], font: "Comic Sans" }] }, /unknown font/],
    ["duplicate element ids", { elements: [landscape.elements[0], { ...landscape.elements[1], id: "p1" }] }, /two elements/],
    ["too many elements", { elements: Array.from({ length: 41 }, (_, i) => ({ ...landscape.elements[0], id: `p${i}` })) }, /40/],
    ["over-long text", { elements: [landscape.elements[0], { ...landscape.elements[2], text: "x".repeat(501) }] }, /500/],
    ["a cell size that doesn't match the paper", { cellWidthPx: 1000 }, /must be/],
  ])("rejects %s", (_name, patch, message) => {
    expect(() => validateTemplate({ ...landscape, ...patch })).toThrow(message);
  });
});

describe("legacy templates", () => {
  const legacy = {
    id: "old",
    printSize: "4x6",
    cellWidthPx: SHEET_HEIGHT_PX,
    cellHeightPx: SHEET_WIDTH_PX,
    photoSlots: [
      { x: 30, y: 30, width: 1110, height: 1140 },
      { x: 1170, y: 30, width: 600, height: 555 },
    ],
    overlayFile: "old-overlay.png",
  };

  it("converts slots to photo elements and the overlay to a full-cell top image", () => {
    const t = validateTemplate(legacy);
    expect(t.background).toBe("#ffffff");
    expect(t.elements).toEqual([
      { id: "photo-1", type: "photo", shot: 0, x: 30, y: 30, width: 1110, height: 1140, rotation: 0, hidden: false },
      { id: "photo-2", type: "photo", shot: 1, x: 1170, y: 30, width: 600, height: 555, rotation: 0, hidden: false },
      { id: "overlay", type: "image", file: "old-overlay.png", x: 0, y: 0, width: 1800, height: 1200, rotation: 0, hidden: false },
    ]);
  });

  it("round-trips through the legacy view the current kiosk reads", () => {
    const view = withLegacyFields(validateTemplate(legacy));
    expect(view.photoSlots).toEqual(legacy.photoSlots);
    expect(view.overlayFile).toBe("old-overlay.png");
    // The current kiosk sends back what it was given, with photoSlots edited.
    const moved = validateTemplate({ ...view, photoSlots: [{ x: 0, y: 0, width: 900, height: 600 }], overlayFile: null });
    expect(moved.elements).toHaveLength(1);
    expect(moved.elements[0]).toMatchObject({ type: "photo", x: 0, width: 900 });
  });

  it("reports no overlay when the top element isn't a full-cell image", () => {
    expect(withLegacyFields(validateTemplate(landscape)).overlayFile).toBeNull();
  });

  it("migrates every shipped default template", () => {
    const shipped = path.join(__dirname, "..", "assets", "templates");
    const ids = readdirSync(shipped).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    expect(ids.length).toBeGreaterThanOrEqual(4);
    for (const id of ids) expect(shotCount(loadTemplate(shipped, id))).toBeGreaterThan(0);
  });
});

describe("saveTemplate (layout editor)", () => {
  it("saves a layout and lists it", () => {
    saveTemplate(templateDir, landscape);
    expect(loadTemplate(templateDir, "my-grid").name).toBe("My grid");
    expect(listTemplates(templateDir).map((t) => t.id)).toContain("my-grid");
  });

  it("rejects a path-traversal id", () => {
    expect(() => saveTemplate(templateDir, { ...landscape, id: "../evil" })).toThrow(/Invalid templateId/);
  });

  it("recognises only the layout's own uploads as its assets", () => {
    expect(isOwnAsset("my-grid", "my-grid-3fa9c1.png")).toBe(true);
    expect(isOwnAsset("my-grid", "my-grid-overlay.png")).toBe(true);
    expect(isOwnAsset("my-grid", "my-grid-a-b.png")).toBe(false);
    expect(isOwnAsset("my", "my-grid-3fa9c1.png")).toBe(false);
    expect(isOwnAsset("my-grid", "my-grid-3fa9c1.gif")).toBe(false);
  });

  it("won't point an image at an arbitrary or missing file", async () => {
    const image = (file: string) => ({
      ...landscape,
      elements: [...landscape.elements, { id: "i1", type: "image", file, x: 0, y: 0, width: 10, height: 10 }],
    });
    expect(() => saveTemplate(templateDir, image("../../secret.png"))).toThrow(/doesn't belong/);
    expect(() => saveTemplate(templateDir, image("my-grid-abc123.png"))).toThrow(/missing/);
    await writeFile(path.join(templateDir, "my-grid-abc123.png"), "x");
    expect(saveTemplate(templateDir, image("my-grid-abc123.png")).elements).toHaveLength(5);
  });

  it("keeps a hand-placed image the layout already uses", async () => {
    await writeFile(path.join(templateDir, "frame.png"), "x");
    await writeFile(
      path.join(templateDir, "hand.json"),
      JSON.stringify({ ...landscape, id: "hand", elements: [...landscape.elements, { id: "f", type: "image", file: "frame.png", x: 0, y: 0, width: 10, height: 10 }] })
    );
    const current = loadTemplate(templateDir, "hand");
    expect(() => saveTemplate(templateDir, { ...current, name: "Renamed" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run tests/template.test.ts`
Expected: FAIL, because `validateTemplate`, `withLegacyFields`, `shotCount` and `isOwnAsset` aren't exported and the new-format input is rejected.

- [ ] **Step 3: Implement**

Replace everything in `src/compositor/template.ts` above `export function loadTemplate` with:

```ts
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
```

Keep `loadTemplate` and `listTemplates` as they are. Replace `saveTemplate` and everything below it (`deleteTemplate`, `overlayFileName`, `resolveOverlayPath`) with:

```ts
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
```

Asset cleanup comes in Task 3. `readdirSync` stays imported because `listTemplates` uses it.

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run tests/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compositor/template.ts tests/template.test.ts
git commit -m "feat: element-based layout schema with legacy migration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Layout assets on disk

**Files:**
- Modify: `src/compositor/template.ts` (add `saveAsset`, `assetPath`, `pruneAssets`; call `pruneAssets` from `saveTemplate` and `deleteTemplate`)
- Test: `tests/template.assets.test.ts`

**Interfaces:**
- Consumes: `isOwnAsset`, `imageFiles`, `assertSafeTemplateId`, `loadTemplate`, `listTemplates` from Task 2.
- Produces: `saveAsset(templateDir: string, templateId: string, body: unknown): Promise<string>` (returns the new file name), `assetPath(templateDir: string, templateId: string, file: string): string` (throws if the file isn't the layout's), `pruneAssets(templateDir: string, templateId: string): void`

- [ ] **Step 1: Write the failing test**

`tests/template.assets.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { saveAsset, assetPath, saveTemplate, deleteTemplate } from "../src/compositor/template";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-assets-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const png = () => sharp({ create: { width: 4, height: 4, channels: 4, background: "#ff0000" } }).png().toBuffer();
const jpeg = () => sharp({ create: { width: 4, height: 4, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();

const layout = (id: string, files: string[]) => ({
  id,
  printSize: "4x6",
  cellWidthPx: 1200,
  cellHeightPx: 1800,
  elements: [
    { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 100, height: 100 },
    ...files.map((file, i) => ({ id: `i${i}`, type: "image", file, x: 0, y: 0, width: 10, height: 10 })),
  ],
});

describe("layout assets", () => {
  it("stores PNG and JPEG uploads under agent-chosen names", async () => {
    const a = await saveAsset(dir, "wed", await png());
    const b = await saveAsset(dir, "wed", await jpeg());
    expect(a).toMatch(/^wed-[0-9a-f]{12}\.png$/);
    expect(b).toMatch(/^wed-[0-9a-f]{12}\.jpg$/);
    expect(existsSync(path.join(dir, a))).toBe(true);
  });

  it("rejects anything that isn't a PNG or JPEG", async () => {
    await expect(saveAsset(dir, "wed", Buffer.from("GIF89a nope"))).rejects.toThrow(/PNG or JPEG/);
    await expect(saveAsset(dir, "wed", Buffer.alloc(0))).rejects.toThrow(/PNG or JPEG/);
    await expect(saveAsset(dir, "../x", await png())).rejects.toThrow(/Invalid templateId/);
  });

  it("serves only the layout's own files", async () => {
    const a = await saveAsset(dir, "wed", await png());
    expect(assetPath(dir, "wed", a)).toBe(path.join(dir, a));
    expect(() => assetPath(dir, "wed", "../booth.config.json")).toThrow(/no image/);
    expect(() => assetPath(dir, "other", a)).toThrow(/no image/);
  });

  it("deletes a layout's unused uploads when it is saved, and all of them when it is deleted", async () => {
    const keep = await saveAsset(dir, "wed", await png());
    const drop = await saveAsset(dir, "wed", await png());
    const other = await saveAsset(dir, "party", await png());
    saveTemplate(dir, layout("party", [other]));

    saveTemplate(dir, layout("wed", [keep]));
    expect(existsSync(path.join(dir, keep))).toBe(true);
    expect(existsSync(path.join(dir, drop))).toBe(false);

    deleteTemplate(dir, "wed");
    expect(existsSync(path.join(dir, keep))).toBe(false);
    expect(existsSync(path.join(dir, other))).toBe(true);
  });

  it("never deletes a file another layout references", async () => {
    const shared = await saveAsset(dir, "wed", await png());
    // Hand-edited: "party" points at a file named like one of wed's uploads.
    await writeFile(path.join(dir, "party.json"), JSON.stringify(layout("party", [shared])));
    saveTemplate(dir, layout("wed", []));
    expect(existsSync(path.join(dir, shared))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `npx vitest run tests/template.assets.test.ts`
Expected: FAIL, because `saveAsset` and `assetPath` aren't exported.

- [ ] **Step 3: Implement**

In `src/compositor/template.ts`, add these imports:

```ts
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
```

Add at the end of the file:

```ts
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
    if (isOwnAsset(templateId, file) && !used.has(file)) unlinkSync(path.join(templateDir, file));
  }
}
```

In `saveTemplate`, after `writeFileSync(...)`, add:

```ts
  pruneAssets(templateDir, template.id);
```

In `deleteTemplate`, after `unlinkSync(...)`, add:

```ts
  pruneAssets(templateDir, templateId);
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run tests/template.assets.test.ts tests/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compositor/template.ts tests/template.assets.test.ts
git commit -m "feat: store, serve and clean up layout image assets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Element renderer

**Files:**
- Modify: `src/compositor/compositor.ts` (the `CompositeParams`, `renderCell` and `renderComposite` call sites)
- Modify: `tests/compositor.multi.test.ts`, `tests/compositor.strip.test.ts` (new params)
- Test: `tests/compositor.elements.test.ts`

**Interfaces:**
- Consumes: `EventTemplate`, `LayoutElement`, `TextElement`, `validateTemplate` (Task 2); `findFont`, `FONT_DIR` (Task 1); `TextVariables`, `fillVariables` (Task 1).
- Produces: `interface CompositeParams { sourceImagePaths: string[]; template: EventTemplate; assetDir: string; variables: TextVariables; printSize: PrintSize; outputDir: string; jpegQuality: number }`. `renderComposite(params): Promise<CompositeResult>` keeps its name and result. `overlayPath` is gone.

- [ ] **Step 1: Write the failing test**

`tests/compositor.elements.test.ts`. It uses a portrait 1200x1800 cell, which is the sheet itself, so cell coordinates are sheet coordinates.

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { renderComposite } from "../src/compositor/compositor";
import { validateTemplate } from "../src/compositor/template";
import { TextVariables } from "../src/compositor/variables";

type Rgb = { r: number; g: number; b: number };
const RED: Rgb = { r: 220, g: 30, b: 30 };
const BLUE: Rgb = { r: 30, g: 30, b: 220 };
const VARS: TextVariables = { event: "Gigsmore Launch", date: "24 Sep 2026", time: "14:05", code: "e2e116bb" };

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "booth-elements-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function solid(color: Rgb, ext = "jpg"): Promise<string> {
  const file = path.join(workDir, `src-${randomUUID()}.${ext}`);
  await sharp({ create: { width: 600, height: 400, channels: 3, background: color } }).toFile(file);
  return file;
}

const photo = { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 100, height: 100 };

async function render(elements: unknown[], extra: Record<string, unknown> = {}, sources?: string[]) {
  const template = validateTemplate({
    id: "t",
    printSize: "4x6",
    cellWidthPx: 1200,
    cellHeightPx: 1800,
    elements,
    ...extra,
  });
  const result = await renderComposite({
    sourceImagePaths: sources ?? [await solid(RED)],
    template,
    assetDir: workDir,
    variables: VARS,
    printSize: "4x6",
    outputDir: workDir,
    jpegQuality: 95,
  });
  return result.filePath;
}

async function pixel(file: string, x: number, y: number): Promise<Rgb> {
  const { data } = await sharp(file).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return { r: data[0]!, g: data[1]!, b: data[2]! };
}

const near = (a: Rgb, b: Rgb) => Math.abs(a.r - b.r) < 40 && Math.abs(a.g - b.g) < 40 && Math.abs(a.b - b.b) < 40;

/** Pixels in a region darker than mid-grey: "ink" for black text on white. */
async function darkPixels(file: string, left: number, top: number, width: number, height: number): Promise<number> {
  const { data } = await sharp(file).extract({ left, top, width, height }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);
}

describe("element renderer", () => {
  it("fills the background colour", async () => {
    const file = await render([photo], { background: "#1e1edc" });
    expect(near(await pixel(file, 600, 900), BLUE)).toBe(true);
  });

  it("places each photo element's shot, including a repeated shot", async () => {
    const file = await render(
      [
        { ...photo, id: "a", shot: 1, x: 0, y: 0, width: 600, height: 400 },
        { ...photo, id: "b", shot: 0, x: 600, y: 0, width: 600, height: 400 },
        { ...photo, id: "c", shot: 1, x: 0, y: 1000, width: 600, height: 400 },
      ],
      {},
      [await solid(RED), await solid(BLUE)]
    );
    expect(near(await pixel(file, 300, 200), BLUE)).toBe(true);
    expect(near(await pixel(file, 900, 200), RED)).toBe(true);
    expect(near(await pixel(file, 300, 1200), BLUE)).toBe(true);
  });

  it("draws later elements on top and skips hidden ones", async () => {
    const file = await render([
      { ...photo, width: 600, height: 600 },
      { id: "r", type: "rect", fill: "#1e1edc", x: 0, y: 0, width: 300, height: 300 },
      { id: "h", type: "rect", fill: "#00ff00", x: 0, y: 0, width: 600, height: 600, hidden: true },
    ]);
    expect(near(await pixel(file, 150, 150), BLUE)).toBe(true);
    expect(near(await pixel(file, 450, 450), RED)).toBe(true);
  });

  it("applies a rect's opacity", async () => {
    const file = await render([photo, { id: "r", type: "rect", fill: "#ff0000", opacity: 0.5, x: 200, y: 200, width: 400, height: 400 }]);
    expect(near(await pixel(file, 400, 400), { r: 255, g: 128, b: 128 })).toBe(true);
  });

  it("rotates about the box centre", async () => {
    // 400x100 centred on (600, 900); at 90 degrees it becomes 100x400.
    const file = await render([photo, { id: "r", type: "rect", fill: "#1e1edc", x: 400, y: 850, width: 400, height: 100, rotation: 90 }]);
    expect(near(await pixel(file, 600, 750), BLUE)).toBe(true);
    expect(near(await pixel(file, 450, 900), { r: 255, g: 255, b: 255 })).toBe(true);
  });

  it("rotates clockwise for positive angles, like CSS rotate()", async () => {
    // Same bar at +30 degrees: its right end dips (y grows downward).
    // A point 180px along the axis from the centre is (756, 990).
    const file = await render([photo, { id: "r", type: "rect", fill: "#1e1edc", x: 400, y: 850, width: 400, height: 100, rotation: 30 }]);
    expect(near(await pixel(file, 756, 990), BLUE)).toBe(true);
    expect(near(await pixel(file, 756, 810), { r: 255, g: 255, b: 255 })).toBe(true);
  });

  it("crops elements past the edge, including ones larger than the cell", async () => {
    const file = await render([
      photo,
      { id: "big", type: "rect", fill: "#1e1edc", x: -100, y: 1700, width: 3000, height: 400 },
      { id: "off", type: "rect", fill: "#00ff00", x: 5000, y: 5000, width: 10, height: 10 },
    ]);
    expect(near(await pixel(file, 5, 1790), BLUE)).toBe(true);
    expect(near(await pixel(file, 1195, 1790), BLUE)).toBe(true);
  });

  it("draws an uploaded image stretched to its box", async () => {
    const asset = path.basename(await solid(BLUE, "png"));
    const file = await render([photo, { id: "i", type: "image", file: asset, x: 100, y: 500, width: 1000, height: 300 }]);
    expect(near(await pixel(file, 600, 650), BLUE)).toBe(true);
  });

  it("renders text inside its box, bolder when bold", async () => {
    const text = { id: "t", type: "text", text: "{event} {date}", font: "Manrope", size: 60, color: "#000000", x: 100, y: 600, width: 1000, height: 200 };
    const regular = await darkPixels(await render([photo, text]), 100, 600, 1000, 200);
    const bold = await darkPixels(await render([photo, { ...text, bold: true }]), 100, 600, 1000, 200);
    expect(regular).toBeGreaterThan(500);
    expect(bold).toBeGreaterThan(regular * 1.1);
    // Nothing leaks out of the box.
    const file = await render([photo, text]);
    expect(await darkPixels(file, 100, 400, 1000, 200)).toBe(0);
    expect(await darkPixels(file, 100, 800, 1000, 200)).toBe(0);
  });

  it("aligns text left and right within its box", async () => {
    const text = { id: "t", type: "text", text: "Hi", font: "Manrope", size: 80, color: "#000000", x: 0, y: 600, width: 1200, height: 200 };
    const left = await render([photo, { ...text, align: "left" }]);
    const right = await render([photo, { ...text, align: "right" }]);
    expect(await darkPixels(left, 0, 600, 300, 200)).toBeGreaterThan(0);
    expect(await darkPixels(left, 900, 600, 300, 200)).toBe(0);
    expect(await darkPixels(right, 900, 600, 300, 200)).toBeGreaterThan(0);
    expect(await darkPixels(right, 0, 600, 300, 200)).toBe(0);
  });

  it("escapes markup characters and skips empty text", async () => {
    const text = { id: "t", type: "text", text: "Tom & Jerry <3", font: "Great Vibes", size: 60, color: "#000000", x: 100, y: 600, width: 1000, height: 200 };
    expect(await darkPixels(await render([photo, text]), 100, 600, 1000, 200)).toBeGreaterThan(0);
    await expect(render([photo, { ...text, text: "   " }])).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `npx vitest run tests/compositor.elements.test.ts`
Expected: FAIL. Nothing is drawn (the old `renderCell` reads `template.photoSlots`), or it errors on `photoSlots` being undefined.

- [ ] **Step 3: Implement**

In `src/compositor/compositor.ts`, replace the imports, `CompositeParams` and `renderCell` with:

```ts
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp, { Sharp, OverlayOptions } from "sharp";
import { v4 as uuidv4 } from "uuid";
import { EventTemplate, LayoutElement, TextElement } from "./template";
import { findFont, FONT_DIR } from "./fonts";
import { TextVariables, fillVariables } from "./variables";
import {
  SHEET_WIDTH_PX,
  SHEET_HEIGHT_PX,
  STRIP_CELL_WIDTH_PX,
  STRIP_CELL_HEIGHT_PX,
  DPI,
} from "./dimensions";
import { PrintSize } from "../config/schema";

export interface CompositeParams {
  /** One photo per shot, in shot order. Fewer photos than shots repeat from the start. */
  sourceImagePaths: string[];
  template: EventTemplate;
  /** Where the template's image assets live (the template directory). */
  assetDir: string;
  /** Values for {event} {date} {time} {code} in text elements. */
  variables: TextVariables;
  printSize: PrintSize;
  outputDir: string;
  jpegQuality: number;
}

export interface CompositeResult {
  filePath: string;
  width: number;
  height: number;
}

interface CellParams {
  sourceImagePaths: string[];
  template: EventTemplate;
  assetDir: string;
  variables: TextVariables;
}

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

const escapeMarkup = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Composite entry for an image placed at (left, top), cropped to a
 * canvasW x canvasH canvas. sharp rejects overlays larger than the canvas, so
 * everything is cropped first. Null when nothing of it is on the canvas.
 */
async function cropped(input: Buffer, left: number, top: number, canvasW: number, canvasH: number): Promise<OverlayOptions | null> {
  const { width = 0, height = 0 } = await sharp(input).metadata();
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(canvasW, left + width);
  const y1 = Math.min(canvasH, top + height);
  if (x1 <= x0 || y1 <= y0) return null;
  const part = await sharp(input)
    .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
    .png()
    .toBuffer();
  return { input: part, left: x0, top: y0 };
}

/**
 * Text wrapped to the box width, aligned across, centred down. Pango trims
 * its output to the text itself, so the text is placed on a transparent
 * box-sized canvas here; text taller than the box is cropped.
 */
async function renderText(el: TextElement, variables: TextVariables): Promise<Buffer | null> {
  const text = fillVariables(el.text, variables);
  if (!text.trim()) return null;
  const font = findFont(el.font)!; // validateTemplate only lets bundled fonts through
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${el.color}">${escapeMarkup(text)}</span>`,
      font: `${font.family}${el.bold && font.hasBold ? " Bold" : ""} ${el.size}px`,
      fontfile: path.join(FONT_DIR, font.file),
      width: el.width,
      align: el.align === "center" ? "centre" : el.align,
      wrap: "word-char",
      rgba: true,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left =
    el.align === "left" ? 0 : el.align === "right" ? el.width - info.width : Math.round((el.width - info.width) / 2);
  const placed = await cropped(data, left, Math.round((el.height - info.height) / 2), el.width, el.height);
  return sharp({ create: { width: el.width, height: el.height, channels: 4, background: TRANSPARENT } })
    .composite(placed ? [placed] : [])
    .png()
    .toBuffer();
}

/** One element drawn at its own width x height, unrotated. Null = nothing to draw. */
async function renderElement(el: LayoutElement, params: CellParams): Promise<Buffer | null> {
  switch (el.type) {
    case "photo":
      return sharp(params.sourceImagePaths[el.shot % params.sourceImagePaths.length])
        .rotate() // normalize EXIF orientation before placing
        .resize(el.width, el.height, { fit: "cover", position: "centre" })
        .png()
        .toBuffer();
    case "image":
      return sharp(path.join(params.assetDir, el.file)).resize(el.width, el.height, { fit: "fill" }).png().toBuffer();
    case "rect": {
      const r = Math.min(el.radius, el.width / 2, el.height / 2);
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${el.width}" height="${el.height}">` +
        `<rect width="${el.width}" height="${el.height}" rx="${r}" ry="${r}" fill="${el.fill}" fill-opacity="${el.opacity}"/></svg>`;
      return sharp(Buffer.from(svg)).png().toBuffer();
    }
    case "text":
      return renderText(el, params.variables);
  }
}

/** Renders one printable cell (a 4x6 sheet, or a single 2x6 strip) as a PNG buffer. */
async function renderCell(params: CellParams): Promise<Buffer> {
  const { sourceImagePaths, template } = params;
  if (sourceImagePaths.length === 0) throw new Error("renderComposite needs at least one source image");

  const composites: OverlayOptions[] = [];
  for (const el of template.elements) {
    if (el.hidden) continue;
    let image = await renderElement(el, params);
    if (!image) continue;
    let left = el.x;
    let top = el.y;
    if (el.rotation !== 0) {
      // Rotating grows the image to its new bounding box; keep the centre put.
      const { data, info } = await sharp(image)
        .rotate(el.rotation, { background: TRANSPARENT })
        .png()
        .toBuffer({ resolveWithObject: true });
      image = data;
      left = Math.round(el.x + el.width / 2 - info.width / 2);
      top = Math.round(el.y + el.height / 2 - info.height / 2);
    }
    const entry = await cropped(image, left, top, template.cellWidthPx, template.cellHeightPx);
    if (entry) composites.push(entry);
  }

  return sharp({
    create: {
      width: template.cellWidthPx,
      height: template.cellHeightPx,
      channels: 4,
      background: template.background,
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}
```

In `renderComposite`, replace both `renderCell({ sourceImagePaths: ..., template: ..., overlayPath: ... })` calls with:

```ts
    const cell = await renderCell(params);
```

`params` is a `CompositeParams`, which has every `CellParams` field.

- [ ] **Step 4: Update the existing compositor tests to the new params**

In `tests/compositor.multi.test.ts` and `tests/compositor.strip.test.ts`, replace each `overlayPath: null,` with:

```ts
      assetDir: templateDir,
      variables: { event: "Test", date: "24 Sep 2026", time: "14:05", code: "abcdefgh" },
```

In `tests/compositor.multi.test.ts`, replace both loops over `template.photoSlots` with a loop over the photo elements:

```ts
    const colors = [RED, GREEN, BLUE, YELLOW];
    const slots = template.elements.flatMap((e) => (e.type === "photo" ? [e] : []));
    for (const [i, slot] of slots.entries()) {
```

and

```ts
    for (const slot of template.elements.flatMap((e) => (e.type === "photo" ? [e] : []))) {
```

The body of each loop uses `slot.x`, `slot.y`, `slot.width` and `slot.height` and doesn't change. The first loop still indexes `colors[i]`, which works because shot `i` is the `i`-th photo element in a migrated template.

- [ ] **Step 5: Run the tests and check they pass**

Run: `npx vitest run tests/compositor.elements.test.ts tests/compositor.multi.test.ts tests/compositor.strip.test.ts`
Expected: PASS.

If "rotates clockwise for positive angles" fails with blue at (756, 810) instead, then sharp rotates counter-clockwise. Negate the angle (`.rotate(-el.rotation, …)`) so the rendering matches CSS `rotate()`, which the editor will use, and record this in the commit message. Don't change the test.

- [ ] **Step 6: Commit**

```bash
git add src/compositor/compositor.ts tests/compositor.elements.test.ts tests/compositor.multi.test.ts tests/compositor.strip.test.ts
git commit -m "feat: render layout elements - photos, images, text, shapes, rotation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Routes, config and docs

**Files:**
- Modify: `src/server/routes.ts` (imports, `/composite`, template routes, `/session`)
- Modify: `src/config/schema.ts:88-90`, `booth.config.example.json`, `README.md` (config table and API section)
- Test: `tests/templates.routes.test.ts`

**Interfaces:**
- Consumes: `withLegacyFields`, `shotCount`, `saveAsset`, `assetPath`, `loadTemplate`, `listTemplates`, `saveTemplate`, `deleteTemplate` (Tasks 2 and 3); `FONTS`, `fontFilePath` (Task 1); `textVariables` (Task 1); `renderComposite` with `assetDir`/`variables` (Task 4); `buildHttpApp(ctx: AgentContext)` from `src/server/http.ts`.
- Produces (HTTP):
  - `GET /templates` returns `{ templates: ApiTemplate[] }`
  - `POST /templates/:id` returns `ApiTemplate`
  - `POST /templates/:id/assets` (body `image/png` or `image/jpeg`, max 10 MB) returns `201 { file }`
  - `GET /templates/:id/assets/:file` returns the image
  - `GET /fonts` returns `{ fonts: BundledFont[] }`
  - `GET /fonts/:file` returns the TTF
  - `POST /templates/:id/overlay` (compat) returns `ApiTemplate`
  - `GET /templates/:id/overlay` (compat) returns the image
  - `GET` and `POST /session` return `template` as an `ApiTemplate`

- [ ] **Step 1: Write the failing test**

`tests/templates.routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import sharp from "sharp";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";

const SECRET = "test-secret";
let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-routes-"));
  await writeFile(
    path.join(dir, "old.json"),
    JSON.stringify({
      id: "old",
      printSize: "4x6",
      cellWidthPx: 1800,
      cellHeightPx: 1200,
      photoSlots: [{ x: 60, y: 60, width: 810, height: 540 }, { x: 930, y: 60, width: 810, height: 540 }],
      overlayFile: null,
    })
  );
  // Only the template routes run here; they touch nothing but config.
  const ctx = {
    configStore: {
      current: {
        agent: { allowedOrigins: [], sharedSecret: SECRET },
        compositing: { templateDir: dir },
        event: { id: "evt" },
        storage: { dataDir: dir },
      },
    },
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${SECRET}` };
const png = () => sharp({ create: { width: 8, height: 8, channels: 4, background: "#ff0000" } }).png().toBuffer();

describe("layout routes", () => {
  it("lists legacy layouts with both elements and the old fields", async () => {
    const { templates } = await (await fetch(`${base}/templates`, { headers: auth })).json();
    expect(templates[0].elements).toHaveLength(2);
    expect(templates[0].photoSlots).toHaveLength(2);
    expect(templates[0].overlayFile).toBeNull();
  });

  it("uploads an asset and saves a layout that uses it", async () => {
    const up = await fetch(`${base}/templates/new/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "image/png" },
      body: await png(),
    });
    expect(up.status).toBe(201);
    const { file } = await up.json();

    const img = await fetch(`${base}/templates/new/assets/${file}?token=${SECRET}`);
    expect(img.status).toBe(200);

    const save = await fetch(`${base}/templates/new`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        printSize: "4x6",
        cellWidthPx: 1200,
        cellHeightPx: 1800,
        elements: [
          { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 600, height: 400 },
          { id: "i", type: "image", file, x: 0, y: 0, width: 1200, height: 1800 },
        ],
      }),
    });
    expect(save.status).toBe(200);
    expect((await save.json()).overlayFile).toBe(file);
  });

  it("rejects a non-image upload and a foreign asset path", async () => {
    const up = await fetch(`${base}/templates/new/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "image/png" },
      body: "not a png",
    });
    expect(up.status).toBe(400);
    expect((await fetch(`${base}/templates/new/assets/old.json`, { headers: auth })).status).toBe(404);
  });

  it("replaces the overlay through the compat route without touching the photos", async () => {
    const res = await fetch(`${base}/templates/old/overlay`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "image/png" },
      body: await png(),
    });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved.photoSlots).toHaveLength(2);
    expect(saved.overlayFile).toMatch(/^old-[0-9a-f]+\.png$/);
    expect((await fetch(`${base}/templates/old/overlay`, { headers: auth })).status).toBe(200);
  });

  it("lists and serves bundled fonts, and nothing else", async () => {
    const { fonts } = await (await fetch(`${base}/fonts`, { headers: auth })).json();
    expect(fonts.map((f: { family: string }) => f.family)).toContain("Manrope");
    expect((await fetch(`${base}/fonts/Manrope.ttf`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/fonts/..%2Fpackage.json`, { headers: auth })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `npx vitest run tests/templates.routes.test.ts`
Expected: FAIL. `routes.ts` still imports the removed `resolveOverlayPath`/`overlayFileName`, so it fails to compile or the routes are missing.

- [ ] **Step 3: Implement the routes**

In `src/server/routes.ts`, replace the template import block with:

```ts
import {
  loadTemplate,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  saveAsset,
  assetPath,
  shotCount,
  withLegacyFields,
} from "../compositor/template";
import { FONTS, fontFilePath } from "../compositor/fonts";
import { textVariables } from "../compositor/variables";
```

Leave the `node:fs/promises` import as it is: `downloadAiOutput` still uses `mkdir` and `writeFile`.

In `/composite`, replace:

```ts
      const template = loadTemplate(config.compositing.templateDir, templateId);
      const overlayPath = resolveOverlayPath(config.compositing.templateDir, template);
```

with:

```ts
      const template = loadTemplate(config.compositing.templateDir, templateId);
```

and in the `renderComposite({...})` call, replace `overlayPath,` with:

```ts
        assetDir: config.compositing.templateDir,
        variables: textVariables(config.event.name ?? config.event.id, captureId),
```

Replace the `GET /templates` handler body's `res.json` with:

```ts
    res.json({ templates: listTemplates(dir).map(withLegacyFields) });
```

In `POST /templates/:id`, replace the log line and `res.json(template)` with:

```ts
      log.info(`Saved layout ${template.id} (${shotCount(template)} photos, ${template.elements.length} elements)`);
      res.json(withLegacyFields(template));
```

Replace the whole `POST /templates/:id/overlay` and `GET /templates/:id/overlay` block with:

```ts
  // Images a layout draws (logos, frames, stickers). The agent names the file;
  // the layout then refers to it from an image element.
  router.post(
    "/templates/:id/assets",
    express.raw({ type: ["image/png", "image/jpeg"], limit: "10mb" }),
    asyncHandler(async (req: Request, res: Response) => {
      const dir = ctx.configStore.current.compositing.templateDir;
      try {
        res.status(201).json({ file: await saveAsset(dir, String(req.params["id"]), req.body) });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })
  );

  router.get("/templates/:id/assets/:file", (req: Request<{ id: string; file: string }>, res: Response) => {
    const dir = ctx.configStore.current.compositing.templateDir;
    try {
      res.sendFile(path.resolve(assetPath(dir, req.params.id, req.params.file)), (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "image file is missing" });
      });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Compat for the current kiosk editor: one full-sheet overlay on top.
  // Remove with the kiosk editor rewrite (layout elements PR 2).
  router.post(
    "/templates/:id/overlay",
    express.raw({ type: "image/png", limit: "10mb" }),
    asyncHandler(async (req: Request, res: Response) => {
      const dir = ctx.configStore.current.compositing.templateDir;
      const id = String(req.params["id"]);
      try {
        const template = loadTemplate(dir, id);
        const file = await saveAsset(dir, id, req.body);
        const { overlayFile } = withLegacyFields(template);
        const below = overlayFile ? template.elements.slice(0, -1) : template.elements;
        const overlay = {
          id: `overlay-${file.slice(id.length + 1, id.length + 9)}`,
          type: "image" as const,
          file,
          x: 0,
          y: 0,
          width: template.cellWidthPx,
          height: template.cellHeightPx,
          rotation: 0,
          hidden: false,
        };
        res.json(withLegacyFields(saveTemplate(dir, { ...template, elements: [...below, overlay] })));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })
  );

  router.get("/templates/:id/overlay", (req: Request<{ id: string }>, res: Response) => {
    const dir = ctx.configStore.current.compositing.templateDir;
    try {
      const { overlayFile } = withLegacyFields(loadTemplate(dir, req.params.id));
      if (!overlayFile) {
        res.status(404).json({ error: "this layout has no overlay" });
        return;
      }
      res.sendFile(path.resolve(dir, overlayFile), (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "overlay file is missing" });
      });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Fonts text elements can use; the kiosk editor loads the same files.
  router.get("/fonts", (_req: Request, res: Response) => {
    res.json({ fonts: FONTS });
  });

  router.get("/fonts/:file", (req: Request<{ file: string }>, res: Response) => {
    const file = fontFilePath(req.params.file);
    if (!file) {
      res.status(404).json({ error: "no such font" });
      return;
    }
    res.sendFile(file);
  });
```

In `GET /session`, replace `template: loadTemplate(...)` with `template: withLegacyFields(loadTemplate(config.compositing.templateDir, settings.templateId))`. In `POST /session`, replace `res.json({ ...parsed.data, template })` with `res.json({ ...parsed.data, template: withLegacyFields(template) })`.

Delete `import sharp from "sharp";` from `routes.ts`: the old overlay route was its only user (`noUnusedLocals` would flag it).

- [ ] **Step 4: Add `event.name` to the config**

`src/config/schema.ts`, the `event` object:

```ts
  event: z.object({
    id: z.string(),
    /** Shown in layouts as {event}. Falls back to id. */
    name: z.string().optional(),
  }),
```

`booth.config.example.json`: add `"name": "Gigsmore Launch"` next to the event's `"id"`.

- [ ] **Step 5: Update the README**

In the config table, add a row right after the `event.id` row:

```
| `event.name` | Optional. The event's display name, printed wherever a layout's text says `{event}`. Falls back to `event.id`. |
```

Change the `compositing.templateDir` row's text "template files and their overlay PNGs live" to "template files and the images their layouts use live", and "Each photo slot takes one shot, so the slot count is how many photos a guest takes." to "Each photo element takes one shot (its `shot` number); the highest shot + 1 is how many photos a guest takes. Old `photoSlots` templates still load and are converted."

Replace the `GET /templates` bullet in the API section with:

```
- `GET /templates` - every layout in `compositing.templateDir`. A layout is a background colour plus `elements` in layer order (bottom first): `photo` (`shot`), `image` (`file`), `text` (`text`, `font`, `size`, `color`, `align`, `bold`; `{event}` `{date}` `{time}` `{code}` are filled in per print) and `rect` (`fill`, `radius`, `opacity`), each with `x`, `y`, `width`, `height`, `rotation` and `hidden`. Responses also carry the old `photoSlots`/`overlayFile` fields, derived, for the current kiosk. `POST /templates/:id` saves one (old or new format; validated for cell size, shots, fonts and images). `POST /templates/:id/delete` removes one and its images (`409` if it's the layout in use). `POST /templates/:id/assets` uploads an image (`Content-Type: image/png` or `image/jpeg`, max 10 MB) and returns `{ file }`; `GET /templates/:id/assets/:file` serves it. `GET /fonts` lists the bundled fonts and `GET /fonts/:file` serves one. `POST`/`GET /templates/:id/overlay` remain for the current kiosk editor. Everything is POST so the CORS allowlist stays GET/POST.
```

- [ ] **Step 6: Run the full suite, typecheck and build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, all tests PASS, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes.ts src/config/schema.ts booth.config.example.json README.md tests/templates.routes.test.ts
git commit -m "feat: layout asset, font and element routes; {event} from config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: PR, deploy and check on the booth PC

No new code. Each step that changes shared state needs the user's go-ahead.

- [ ] **Step 1: Push and open the PR** (ask the user first)

```bash
git push -u origin feat/layout-elements
gh pr create --base master --title "feat: element-based layouts (PR 1 of 4: agent)" --body-file pr-body.md
```

Write `pr-body.md` (don't commit it) with: a link to the spec; what changed (element schema and migration, renderer, fonts, text variables, asset/font routes, `event.name`); the compat note (the current kiosk keeps working through the derived `photoSlots`/`overlayFile` and the overlay routes, which are removed in PR 2); the test files added; and the deploy note (restart the service, add `event.name` to `booth.config.json`). End it with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 2: After the user merges, deploy**

```bash
git checkout master && git pull && npm run build
```

`npm ci` must never run while the service is running, because it deletes node_modules, and the running service holds sharp's native files open on Windows; the branch changes no dependencies.

Then:
- Back up the live templates, since the first save rewrites a layout in the new format and replacing an overlay deletes the old PNG:
  ```bash
  cp -r /c/BoothAgent/templates "/c/BoothAgent/templates.bak-$(date +%Y%m%d)"
  ```
- Add `"name": "Gigsmore Launch"` under `event` in `booth.config.json`. This file is gitignored. Show the user the diff first.
- Ask the user to restart the `boothagent.exe` service from an admin shell.

- [ ] **Step 3: Check the live agent**

Using the kiosk token from `C:\BoothAgent\kiosk\.env.local` (never print it):
- `GET /health` still returns 200.
- `GET /templates` lists all layouts in `C:\BoothAgent\templates` (5, including `overlay-test`). Each has `elements`, `photoSlots` and `overlayFile`. `overlay-test` has `overlayFile: "overlay-test-overlay.png"`.
- `POST /composite` with the four `overlay-test` shots from 2026-09-24 (`e2e116bb…`, `724b03c1…`, `3b23d8d9…`, `dc2bd04d…`; full ids in the session log or the outbox DB) and `templateId: "overlay-test"`. The result must look the same as before: orange frame, photos in the holes. No new captures, no print.
- In the browser pane, open the operator panel on the current kiosk and check: the layout list shows every layout, and the editor opens `overlay-test` with its overlay preview.
- Save `overlay-test` once from the old editor with no changes, and confirm the save succeeds and `GET /templates` still shows its overlay. This exercises migration-on-save.

- [ ] **Step 4: Update memory**

Note in `layout-elements-project.md` that PR 1 is deployed, and that the next step is PR 2 (kiosk editor rewrite).
