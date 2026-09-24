# Layout Elements PR 3 (preview, test print, import/export, save as new) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the kiosk layout editor, the operator can:
- see exactly what a layout prints (a real render with sample photos);
- print one test sheet;
- save the current draft as a new layout;
- export a layout, with its images, to one file and import it on another booth.

**Architecture:**
- **Agent: preview and test print.**
  - A new `renderSheet()` renders a print sheet to a JPEG buffer. `renderComposite()` now writes that buffer to disk.
  - `samples.ts` generates numbered stand-in photos.
  - A draft is validated with the same image-permission rule as a save, extracted into `assertImagesAllowed()`.
  - Endpoints: `POST /layout-preview` (returns the JPEG) and `POST /layout-preview/print`. The print endpoint drops the sheet straight into the hot folder with no capture or print-job row, so nothing syncs to Supabase.
- **Agent: layout files.** `templateTransfer.ts` exports a layout as `{ format, version, template, assets: { file: base64 } }`, imports that as a brand-new layout, and copies a draft as a new layout. In both cases the images are re-stored under the new id.
- **Kiosk.** A Preview dialog with Test print (two-tap confirm), a Save-as-new button, and Import/Export in Settings. The existing `CompositePreview` now takes an image `src`, so the dialog reuses it.

**Tech Stack:** Express 4, zod 3, sharp 0.35, vitest 5 (agent); React 18 + Vite 5 (kiosk).

**Spec:** `docs/superpowers/specs/2026-09-24-layout-elements-design.md`, section 3 "PR 3 additions". Earlier plans: `docs/superpowers/plans/2026-09-24-layout-elements-pr1.md` and `-pr2.md`.

## Global Constraints

- Preview is the exact render the printer gets: the same `renderSheet` path as `/composite`, at 1200x1800 portrait, with a landscape layout turned onto the sheet.
- Sample photos:
  - 3:2 (1800x1200), one per shot, each numbered, generated on demand into `<storage.dataDir>/samples/`.
  - `{event}` uses `event.name || event.id`, and `{code}` shows `a1b2c3d4`.
- A draft sent for preview or test print obeys the same image rule as a save: an image may only be the layout's own upload, or a file the saved layout already uses. Never an arbitrary path.
- Test print:
  - Uses 1 sheet of paper, so the kiosk requires a second tap to confirm.
  - Creates no capture and no print-job row, so nothing syncs to Supabase and guest print history stays clean.
- Layout file format: `{ "format": "kachak-layout", "version": 1, "template": {...}, "assets": { "<file>": "<base64>" } }`.
  - Asset keys are lookup names only and never used as paths. Every asset is re-saved through `saveAsset`, so it must be PNG or JPEG.
- Import and save-as-new always create a new layout and never overwrite one.
  - The new id comes from the name (`wedding-4-up`, then `wedding-4-up-2`, …).
  - If a save fails part-way, no stray image files are left behind.
- `/layout-import` accepts bodies up to 60 MB and parses them only after auth. Every other JSON route keeps the 5 MB global limit.
- New agent routes live outside `/templates/:id` where they could collide with `POST /templates/:id`: `/layout-preview`, `/layout-preview/print`, `/layout-import`. The ones under a template id are `GET /templates/:id/export` and `POST /templates/:id/copy`.
- Deploy order: the agent first (build + user restarts the service), then the kiosk.
- Don't run the agent's root `npm run build` in `C:\Users\User\Documents\booth-agent` before merge: the live service runs `dist/` from it. Kiosk builds (`npm run build --prefix kiosk`) are fine.
- Stage files by explicit path only; never `git add -A` / `git add .`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/layout-preview-transfer`.

## File Structure

| File | Responsibility |
|---|---|
| `src/compositor/samples.ts` (new) | Numbered sample photos, generated once and reused |
| `src/compositor/compositor.ts` | `renderSheet()` (JPEG buffer); `renderComposite()` writes it |
| `src/compositor/template.ts` | `assertImagesAllowed()` extracted from `saveTemplate` |
| `src/compositor/templateTransfer.ts` (new) | `exportLayout`, `importLayout`, `copyLayout`, `freeTemplateId` |
| `src/util/paths.ts` | `samplesDir()` |
| `src/server/routes.ts` | Preview, test print, export, import and copy routes |
| `src/server/http.ts` | Skip the 5 MB global JSON parser for `/layout-import` |
| `README.md` | API docs |
| `kiosk/src/agent.ts` | `previewLayout`, `testPrintLayout`, `exportLayout`, `importLayout`, `copyLayout` |
| `kiosk/src/screens.tsx` | `CompositePreview` takes `src` and is exported |
| `kiosk/src/LayoutEditor.tsx` | Preview dialog with Test print, and Save as new |
| `kiosk/src/Operator.tsx` | Import and Export in Settings |
| `kiosk/src/styles.css`, `kiosk/README.md` | Modal styles; docs |
| Tests | `tests/samples.test.ts`, `tests/layoutPreview.routes.test.ts`, `tests/templateTransfer.test.ts`, `tests/layoutTransfer.routes.test.ts` |

---

### Task 1: Agent — preview and test print

**Files:**
- Create: `src/compositor/samples.ts`, `tests/samples.test.ts`, `tests/layoutPreview.routes.test.ts`
- Modify: `src/compositor/compositor.ts`, `src/compositor/template.ts:229-251`, `src/util/paths.ts`, `src/server/routes.ts`

**Interfaces:**
- Produces:
  - `samplePhotos(dir: string, count: number): Promise<string[]>`
  - `type SheetParams = Omit<CompositeParams, "outputDir">`
  - `renderSheet(params: SheetParams): Promise<Buffer>`
  - `assertImagesAllowed(templateDir: string, template: EventTemplate): void`
  - `samplesDir(config: BoothConfig): string`
  - HTTP:
    - `POST /layout-preview`: body is a template draft; returns `200 image/jpeg`.
    - `POST /layout-preview/print`: returns `202 { jobId }`.

- [ ] **Step 1: Create the branch**

```bash
cd /c/Users/User/Documents/booth-agent
git checkout master && git pull
git checkout -b feat/layout-preview-transfer
```

- [ ] **Step 2: Write the failing tests**

`tests/samples.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { samplePhotos } from "../src/compositor/samples";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-samples-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sample photos", () => {
  it("makes one 3:2 photo per shot and reuses them", async () => {
    const files = await samplePhotos(path.join(dir, "samples"), 3);
    expect(files.map((f) => path.basename(f))).toEqual(["sample-1.jpg", "sample-2.jpg", "sample-3.jpg"]);
    const meta = await sharp(files[0]!).metadata();
    expect([meta.width, meta.height]).toEqual([1800, 1200]);

    const before = (await stat(files[0]!)).mtimeMs;
    const again = await samplePhotos(path.join(dir, "samples"), 3);
    expect(again).toEqual(files);
    expect((await stat(again[0]!)).mtimeMs).toBe(before);
  });

  it("gives every shot of a 12-shot layout its own photo", async () => {
    expect(await samplePhotos(dir, 12)).toHaveLength(12);
  });
});
```

`tests/layoutPreview.routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import sharp from "sharp";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";

const SECRET = "test-secret";
let root: string;
let templateDir: string;
let hotFolder: string;
let server: Server;
let base: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "booth-preview-"));
  templateDir = path.join(root, "templates");
  hotFolder = path.join(root, "hot");
  await mkdir(templateDir, { recursive: true });
  await writeFile(path.join(root, "outside.png"), await sharp({ create: { width: 4, height: 4, channels: 4, background: "#ff0000" } }).png().toBuffer());
  // Only the layout routes run here; they touch nothing but config.
  const ctx = {
    configStore: {
      current: {
        agent: { allowedOrigins: [], sharedSecret: SECRET },
        compositing: { templateDir, jpegQuality: 90 },
        printing: { hotFolderPath: hotFolder },
        event: { id: "evt", name: "Gigsmore Launch" },
        storage: { dataDir: root },
      },
    },
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

const post = (p: string, body: unknown) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const draft = (extra: object[] = []) => ({
  id: "draft",
  name: "Draft",
  printSize: "4x6",
  cellWidthPx: 1800,
  cellHeightPx: 1200,
  elements: [
    { id: "p1", type: "photo", shot: 0, x: 60, y: 40, width: 810, height: 540 },
    { id: "p2", type: "photo", shot: 1, x: 930, y: 40, width: 810, height: 540 },
    { id: "t", type: "text", text: "{event}", font: "Manrope", size: 80, color: "#222222", x: 60, y: 700, width: 1680, height: 200 },
    ...extra,
  ],
});

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(full);
  }
  return out;
}

describe("layout preview", () => {
  it("renders an unsaved draft as the portrait print sheet", async () => {
    const res = await post("/layout-preview", draft());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/image\/jpeg/);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1800]);
  });

  it("refuses a draft whose image points outside the layout", async () => {
    const bad = draft([{ id: "i", type: "image", file: "../outside.png", x: 0, y: 0, width: 10, height: 10 }]);
    const res = await post("/layout-preview", bad);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/doesn't belong/);
  });

  it("rejects an invalid draft", async () => {
    const res = await post("/layout-preview", { ...draft(), elements: [] });
    expect(res.status).toBe(400);
  });

  it("drops a test print straight into the hot folder", async () => {
    const res = await post("/layout-preview/print", draft());
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    expect(jobId).toMatch(/^test-/);
    const dropped = await filesUnder(hotFolder);
    expect(dropped.some((f) => path.basename(f) === `${jobId}.jpg`)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests and check they fail**

Run: `npx vitest run tests/samples.test.ts tests/layoutPreview.routes.test.ts`
Expected: FAIL. `../src/compositor/samples` can't be resolved, and the routes return 404.

- [ ] **Step 4: Implement the sample photos**

`src/compositor/samples.ts`:

```ts
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const COLORS = ["#e76f51", "#2a9d8f", "#e9c46a", "#457b9d", "#8d6a9f", "#6a994e"];

/**
 * Stand-in guest photos for layout previews and test prints: 3:2 like the
 * Canon's stills, a colour and a big number per shot, so the operator can
 * see which photo box gets which shot. Made once into dir and reused.
 */
export async function samplePhotos(dir: string, count: number): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  // ponytail: no lock; two previews racing on a fresh dir could both write the
  // same file. Fine for one operator; add a lock if previews become concurrent.
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const file = path.join(dir, `sample-${i + 1}.jpg`);
      try {
        await access(file);
        return file;
      } catch {
        // not made yet
      }
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1200">` +
        `<rect width="1800" height="1200" fill="${COLORS[i % COLORS.length]}"/>` +
        `<text x="900" y="600" font-family="sans-serif" font-size="600" font-weight="bold" fill="#ffffff" ` +
        `text-anchor="middle" dominant-baseline="central">${i + 1}</text></svg>`;
      await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toFile(file);
      return file;
    })
  );
}
```

In `src/util/paths.ts`, add:

```ts
export function samplesDir(config: BoothConfig): string {
  return path.join(config.storage.dataDir, "samples");
}
```

- [ ] **Step 5: Split out `renderSheet`**

In `src/compositor/compositor.ts`:

- Change the first import to `import { mkdir, writeFile } from "node:fs/promises";`.
- Add after `CompositeResult`:

```ts
/** Everything renderComposite needs except where to save the file. */
export type SheetParams = Omit<CompositeParams, "outputDir">;
```

- Replace the whole `renderComposite` function, including its doc comment, with the two functions below. The body of `renderSheet` is the old `renderComposite` body, minus the file handling:

```ts
/**
 * The print-ready JPEG at 300dpi, in memory. For "4x6" the cell fills the
 * whole sheet. For "2x6-strip" the same cell is rendered once and mirrored at
 * left and right halves of the sheet, so the DNP's two-up strip cutter
 * produces two identical strips per print. Layout previews use this directly.
 */
export async function renderSheet(params: SheetParams): Promise<Buffer> {
  if (params.template.printSize !== params.printSize) {
    throw new Error(
      `Template "${params.template.id}" is for ${params.template.printSize} but ${params.printSize} was requested`
    );
  }

  let finalImage: Sharp;

  if (params.printSize === "4x6") {
    const cell = await renderCell(params);
    // A landscape layout is turned a quarter onto the portrait sheet the
    // printer feeds; the guest just turns the print round to look at it.
    const landscape = params.template.cellWidthPx > params.template.cellHeightPx;
    const upright = landscape ? await sharp(cell).rotate(90).toBuffer() : cell;
    finalImage = sharp(upright).resize(SHEET_WIDTH_PX, SHEET_HEIGHT_PX, { fit: "fill" });
  } else {
    const cell = await renderCell(params);
    const cellResized = await sharp(cell)
      .resize(STRIP_CELL_WIDTH_PX, STRIP_CELL_HEIGHT_PX, { fit: "fill" })
      .toBuffer();

    finalImage = sharp({
      create: {
        width: SHEET_WIDTH_PX,
        height: SHEET_HEIGHT_PX,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).composite([
      { input: cellResized, left: 0, top: 0 },
      { input: cellResized, left: STRIP_CELL_WIDTH_PX, top: 0 },
    ]);
  }

  return finalImage.jpeg({ quality: params.jpegQuality }).withMetadata({ density: DPI }).toBuffer();
}

/** Renders the print-ready sheet and saves it under outputDir. */
export async function renderComposite(params: CompositeParams): Promise<CompositeResult> {
  const jpeg = await renderSheet(params);
  await mkdir(params.outputDir, { recursive: true });
  const filePath = path.join(params.outputDir, `composite-${uuidv4()}.jpg`);
  await writeFile(filePath, jpeg);
  return { filePath, width: SHEET_WIDTH_PX, height: SHEET_HEIGHT_PX };
}
```

`renderCell(params)` takes a `CellParams`, and a `SheetParams` has every field of it.

- [ ] **Step 6: Extract `assertImagesAllowed`**

In `src/compositor/template.ts`, replace the body of `saveTemplate` (lines 229-251) with:

```ts
export function saveTemplate(templateDir: string, input: unknown): EventTemplate {
  const template = validateTemplate(input);
  assertImagesAllowed(templateDir, template);
  writeFileSync(path.join(templateDir, `${template.id}.json`), JSON.stringify(template, null, 2) + "\n");
  pruneAssets(templateDir, template.id);
  return template;
}

/**
 * An image may be one of this layout's uploads, or a file the layout on disk
 * already uses (a hand-placed overlay) - never an arbitrary path, which would
 * let a save or a preview read any image on disk into the output.
 */
export function assertImagesAllowed(templateDir: string, template: EventTemplate): void {
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
}
```

- [ ] **Step 7: Add the routes**

In `src/server/routes.ts`:

- In the `../compositor/template` import list, add `validateTemplate` and `assertImagesAllowed`.
- Change `import { renderComposite } from "../compositor/compositor";` to `import { renderComposite, renderSheet } from "../compositor/compositor";`.
- Add `import { samplePhotos } from "../compositor/samples";`.
- Add `samplesDir` to the `../util/paths` import.
- Add `import { dropIntoHotFolder } from "../print/hotFolder";`. The existing `isHotFolderWritable` import comes from the same module, so merge the two: `import { isHotFolderWritable, dropIntoHotFolder } from "../print/hotFolder";`.

Add these routes right after the `GET /templates` route. They sit outside `/templates/:id` so they can't collide with `POST /templates/:id`:

```ts
  /** A draft layout (saved or not) rendered with sample photos, exactly as it would print. */
  async function renderDraft(body: unknown) {
    const config = ctx.configStore.current;
    const dir = config.compositing.templateDir;
    const template = validateTemplate(body);
    assertImagesAllowed(dir, template);
    const jpeg = await renderSheet({
      sourceImagePaths: await samplePhotos(samplesDir(config), shotCount(template)),
      template,
      assetDir: dir,
      variables: textVariables(config.event.name || config.event.id, "a1b2c3d4"),
      printSize: template.printSize,
      jpegQuality: config.compositing.jpegQuality,
    });
    return { template, jpeg };
  }

  router.post("/layout-preview", asyncHandler(async (req: Request, res: Response) => {
    try {
      const { jpeg } = await renderDraft(req.body);
      res.type("image/jpeg").send(jpeg);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }));

  // One sheet of paper for the operator: the preview, straight into the hot
  // folder. No capture or print-job row is made, so nothing syncs to Supabase
  // and the guest print history stays clean.
  router.post("/layout-preview/print", asyncHandler(async (req: Request, res: Response) => {
    const config = ctx.configStore.current;
    try {
      const { template, jpeg } = await renderDraft(req.body);
      const dir = compositesDir(config);
      await mkdir(dir, { recursive: true });
      const jobId = `test-${uuidv4()}`;
      const file = path.join(dir, `${jobId}.jpg`);
      await writeFile(file, jpeg);
      await dropIntoHotFolder(config.printing.hotFolderPath, template.printSize, jobId, file);
      log.info(`Test print of layout ${template.id} dropped into the hot folder (${jobId})`);
      res.status(202).json({ jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }));
```

- [ ] **Step 8: Run the tests and check they pass**

Run: `npx vitest run tests/samples.test.ts tests/layoutPreview.routes.test.ts tests/template.test.ts tests/template.assets.test.ts tests/compositor.elements.test.ts tests/compositor.multi.test.ts tests/compositor.strip.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test`
Expected: clean, and all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/compositor/samples.ts src/compositor/compositor.ts src/compositor/template.ts src/util/paths.ts src/server/routes.ts tests/samples.test.ts tests/layoutPreview.routes.test.ts
git commit -m "feat: layout preview and test print with sample photos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Agent — export, import, save as new

**Files:**
- Create: `src/compositor/templateTransfer.ts`, `tests/templateTransfer.test.ts`, `tests/layoutTransfer.routes.test.ts`
- Modify: `src/server/routes.ts`, `src/server/http.ts:14`, `README.md`

**Interfaces:**
- Consumes (from `template.ts`): `assertImagesAllowed` (Task 1), `validateTemplate`, `loadTemplate`, `saveTemplate`, `saveAsset`, `pruneAssets`, `imageFiles`, `EventTemplate`.
- Produces:
  - `LAYOUT_FILE_FORMAT = "kachak-layout"`
  - `interface LayoutBundle { format: "kachak-layout"; version: 1; template: EventTemplate; assets: Record<string, string> }`
  - `exportLayout(templateDir: string, templateId: string): Promise<LayoutBundle>`
  - `importLayout(templateDir: string, bundle: unknown): Promise<EventTemplate>`
  - `copyLayout(templateDir: string, sourceId: string, draft: unknown, name: string): Promise<EventTemplate>`
  - `freeTemplateId(templateDir: string, name: string): string`
  - HTTP:
    - `GET /templates/:id/export`: returns the bundle as JSON.
    - `POST /layout-import`: bundle body, up to 60 MB; returns `201` with the new template.
    - `POST /templates/:id/copy`: body `{ name, template }`; returns `201` with the new template.

- [ ] **Step 1: Write the failing tests**

`tests/templateTransfer.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { saveAsset, saveTemplate, loadTemplate, isOwnAsset } from "../src/compositor/template";
import { exportLayout, importLayout, copyLayout, freeTemplateId } from "../src/compositor/templateTransfer";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-transfer-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const png = (color = "#ff0000") => sharp({ create: { width: 8, height: 8, channels: 4, background: color } }).png().toBuffer();

async function savedLayout(id: string, name: string) {
  const file = await saveAsset(dir, id, await png());
  return saveTemplate(dir, {
    id,
    name,
    printSize: "4x6",
    cellWidthPx: 1800,
    cellHeightPx: 1200,
    elements: [
      { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 900, height: 600 },
      { id: "logo", type: "image", file, x: 1000, y: 100, width: 400, height: 200 },
    ],
  });
}

// isOwnAsset, not a prefix match: "party-" would also match "party-copy-…".
const ownFiles = async (id: string) => (await readdir(dir)).filter((f) => isOwnAsset(id, f));

describe("layout files", () => {
  it("picks a free id from the name", async () => {
    await savedLayout("my-grid", "My grid");
    expect(freeTemplateId(dir, "My grid")).toBe("my-grid-2");
    expect(freeTemplateId(dir, "Wedding 4-up!")).toBe("wedding-4-up");
    expect(freeTemplateId(dir, "婚礼")).toBe("layout");
  });

  it("exports a layout with its images and imports it as a new layout", async () => {
    const original = await savedLayout("my-grid", "My grid");
    const bundle = await exportLayout(dir, "my-grid");
    expect(bundle.format).toBe("kachak-layout");
    expect(Object.keys(bundle.assets)).toHaveLength(1);

    const imported = await importLayout(dir, JSON.parse(JSON.stringify(bundle)));
    expect(imported.id).toBe("my-grid-2");
    expect(imported.name).toBe("My grid");
    const image = imported.elements.find((e) => e.type === "image")!;
    expect(image.type === "image" && image.file.startsWith("my-grid-2-")).toBe(true);
    const oldFile = original.elements.find((e) => e.type === "image")!;
    if (image.type !== "image" || oldFile.type !== "image") throw new Error("image element expected");
    expect(await readFile(path.join(dir, image.file))).toEqual(await readFile(path.join(dir, oldFile.file)));
    expect(loadTemplate(dir, "my-grid").elements).toEqual(original.elements);
  });

  it("rejects a file that isn't a layout, lacks an image, or carries a non-image", async () => {
    const bundle = await exportLayout(dir, (await savedLayout("a", "A")).id);
    await expect(importLayout(dir, { ...bundle, format: "other" })).rejects.toThrow();
    await expect(importLayout(dir, { ...bundle, assets: {} })).rejects.toThrow(/missing image/);
    const [file] = Object.keys(bundle.assets);
    await expect(importLayout(dir, { ...bundle, assets: { [file!]: Buffer.from("hello").toString("base64") } })).rejects.toThrow(/PNG or JPEG/);
  });

  it("leaves no stray images when an import fails part-way", async () => {
    const good = await png();
    const bundle = {
      format: "kachak-layout",
      version: 1,
      template: {
        id: "two",
        name: "Two images",
        printSize: "4x6",
        cellWidthPx: 1800,
        cellHeightPx: 1200,
        elements: [
          { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 900, height: 600 },
          { id: "a", type: "image", file: "two-aaa.png", x: 0, y: 0, width: 10, height: 10 },
          { id: "b", type: "image", file: "two-bbb.png", x: 0, y: 0, width: 10, height: 10 },
        ],
      },
      assets: { "two-aaa.png": good.toString("base64"), "two-bbb.png": Buffer.from("nope").toString("base64") },
    };
    await expect(importLayout(dir, bundle)).rejects.toThrow(/PNG or JPEG/);
    expect(await ownFiles("two-images")).toEqual([]);
    expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  it("saves an edited draft as a new layout and leaves the original alone", async () => {
    const original = await savedLayout("party", "Party");
    const draft = { ...original, elements: original.elements.map((e) => (e.type === "photo" ? { ...e, x: 100 } : e)) };
    const copy = await copyLayout(dir, "party", draft, "Party copy");
    expect(copy.id).toBe("party-copy");
    expect(copy.elements[0]).toMatchObject({ type: "photo", x: 100 });
    expect(loadTemplate(dir, "party").elements[0]).toMatchObject({ x: 0 });
    expect(await ownFiles("party-copy")).toHaveLength(1);
    expect(await ownFiles("party")).toHaveLength(1);
  });

  it("won't copy a draft that points at someone else's image", async () => {
    await savedLayout("party", "Party");
    await writeFile(path.join(dir, "secret.png"), await png());
    const draft = {
      ...loadTemplate(dir, "party"),
      elements: [
        { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 900, height: 600 },
        { id: "x", type: "image", file: "secret.png", x: 0, y: 0, width: 10, height: 10 },
      ],
    };
    await expect(copyLayout(dir, "party", draft, "Stolen")).rejects.toThrow(/doesn't belong/);
  });
});
```

`tests/layoutTransfer.routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import sharp from "sharp";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";
import { saveAsset, saveTemplate } from "../src/compositor/template";

const SECRET = "test-secret";
let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-transfer-routes-"));
  const file = await saveAsset(dir, "grid", await sharp({ create: { width: 8, height: 8, channels: 4, background: "#00ff00" } }).png().toBuffer());
  saveTemplate(dir, {
    id: "grid",
    name: "Grid",
    printSize: "4x6",
    cellWidthPx: 1800,
    cellHeightPx: 1200,
    elements: [
      { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 900, height: 600 },
      { id: "logo", type: "image", file, x: 1000, y: 100, width: 400, height: 200 },
    ],
  });
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
const postJson = (p: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(`${base}${p}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("layout file routes", () => {
  it("exports and re-imports a layout", async () => {
    const res = await fetch(`${base}/templates/grid/export`, { headers: auth });
    expect(res.status).toBe(200);
    const bundle = await res.json();
    const imported = await postJson("/layout-import", bundle);
    expect(imported.status).toBe(201);
    expect((await imported.json()).id).toBe("grid-2");
  });

  it("answers 404 for an unknown layout", async () => {
    expect((await fetch(`${base}/templates/nope/export`, { headers: auth })).status).toBe(404);
  });

  it("accepts layout files larger than the 5 MB limit other routes keep", async () => {
    // Noise doesn't compress, so this PNG is several MB, and more once base64'd.
    const big = await sharp({ create: { width: 1500, height: 1500, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toBuffer();
    const bundle = await (await fetch(`${base}/templates/grid/export`, { headers: auth })).json();
    const [file] = Object.keys(bundle.assets);
    bundle.assets[file] = big.toString("base64");
    expect(bundle.assets[file].length).toBeGreaterThan(5 * 1024 * 1024);
    expect((await postJson("/layout-import", bundle)).status).toBe(201);
    // …while an ordinary route still refuses a body that size (the central
    // error handler answers body-parser's "too large" as an error status).
    const refused = await postJson("/templates/grid/copy", { name: "x", template: bundle.template, pad: bundle.assets[file] });
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  it("requires the shared secret before reading an import body", async () => {
    expect((await postJson("/layout-import", { format: "kachak-layout" }, {})).status).toBe(401);
  });

  it("saves a draft as a new layout", async () => {
    const template = await (await fetch(`${base}/templates/grid/export`, { headers: auth })).json().then((b) => b.template);
    const res = await postJson("/templates/grid/copy", { name: "Grid copy", template });
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe("grid-copy");
    expect((await postJson("/templates/grid/copy", { name: "", template })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run tests/templateTransfer.test.ts tests/layoutTransfer.routes.test.ts`
Expected: FAIL. `../src/compositor/templateTransfer` can't be resolved, and the routes return 404.

- [ ] **Step 3: Implement `src/compositor/templateTransfer.ts`**

```ts
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

export const LAYOUT_FILE_FORMAT = "kachak-layout";

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
}

/** Imports a file made by exportLayout as a new layout; never overwrites one. */
export async function importLayout(templateDir: string, bundle: unknown): Promise<EventTemplate> {
  const parsed = BundleSchema.parse(bundle);
  const template = validateTemplate(parsed.template);
  for (const file of imageFiles(template)) {
    if (!(file in parsed.assets)) throw new Error(`the layout file is missing image "${file}"`);
  }
  return saveAsNewLayout(templateDir, template, template.name ?? template.id, async (file) =>
    Buffer.from(parsed.assets[file]!, "base64")
  );
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
```

- [ ] **Step 4: Skip the 5 MB parser for `/layout-import`**

In `src/server/http.ts`, replace `app.use(express.json({ limit: "5mb" }));` with:

```ts
  // Layout files carry their images as base64 and can be far bigger than any
  // other request. /layout-import parses its own body (after auth) with a
  // larger limit, so the small global parser skips it.
  const json = express.json({ limit: "5mb" });
  app.use((req, res, next) => (req.path === "/layout-import" ? next() : json(req, res, next)));
```

- [ ] **Step 5: Add the routes**

In `src/server/routes.ts`, add:

```ts
import { exportLayout, importLayout, copyLayout } from "../compositor/templateTransfer";
```

Add these routes after the Task 1 preview routes:

```ts
  router.get("/templates/:id/export", asyncHandler(async (req: Request, res: Response) => {
    const dir = ctx.configStore.current.compositing.templateDir;
    try {
      res.json(await exportLayout(dir, String(req.params["id"])));
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }));

  router.post(
    "/layout-import",
    express.json({ limit: "60mb" }),
    asyncHandler(async (req: Request, res: Response) => {
      const dir = ctx.configStore.current.compositing.templateDir;
      try {
        const template = await importLayout(dir, req.body);
        log.info(`Imported layout ${template.id}`);
        res.status(201).json(template);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })
  );

  const CopyRequestSchema = z.object({ name: z.string().trim().min(1).max(80), template: z.unknown() });

  router.post("/templates/:id/copy", asyncHandler(async (req: Request, res: Response) => {
    const dir = ctx.configStore.current.compositing.templateDir;
    const parsed = CopyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "give the new layout a name" });
      return;
    }
    try {
      const template = await copyLayout(dir, String(req.params["id"]), parsed.data.template, parsed.data.name);
      log.info(`Saved layout ${req.params["id"]} as new layout ${template.id}`);
      res.status(201).json(template);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }));
```

- [ ] **Step 6: Document the API**

In `README.md`, after the `GET /templates` bullet in the API section, add:

```
- `POST /layout-preview` renders a draft layout (the template JSON; saved or not) with numbered sample photos and returns the print-ready sheet as `image/jpeg`, exactly as it would print. `POST /layout-preview/print` sends that sheet straight to the hot folder as one test print (`202 { jobId }`); it makes no capture or print-job row, so nothing syncs to Supabase. Drafts follow the same image rule as a save.
- `GET /templates/:id/export` returns one JSON file with the layout and its images (`{ format: "kachak-layout", version: 1, template, assets: { file: base64 } }`). `POST /layout-import` takes that file (up to 60 MB, read only after auth) and saves it as a new layout, never overwriting one. `POST /templates/:id/copy` with `{ name, template }` saves a draft of that layout as a new layout with its images copied ("Save as new"). New ids come from the name.
```

- [ ] **Step 7: Run the tests and check they pass**

Run: `npx vitest run tests/templateTransfer.test.ts tests/layoutTransfer.routes.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test`
Expected: clean, and all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/compositor/templateTransfer.ts src/server/routes.ts src/server/http.ts README.md tests/templateTransfer.test.ts tests/layoutTransfer.routes.test.ts
git commit -m "feat: export, import and save-as-new for layouts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Kiosk — preview, test print, save as new, import/export

**Files:**
- Modify: `kiosk/src/agent.ts`, `kiosk/src/screens.tsx:176-200,211,252`, `kiosk/src/LayoutEditor.tsx`, `kiosk/src/Operator.tsx`, `kiosk/src/styles.css`, `kiosk/README.md`

**Interfaces:**
- Consumes: the Task 1 and Task 2 routes, and `templateBody` from `kiosk/src/layout.ts`.
- Produces (from `kiosk/src/agent.ts`):
  - `agent.previewLayout(t: Template): Promise<Blob>`
  - `agent.testPrintLayout(t: Template): Promise<{ jobId: string }>`
  - `agent.exportLayout(id: string): Promise<object>`
  - `agent.importLayout(bundle: object): Promise<Template>`
  - `agent.copyLayout(sourceId: string, t: Template, name: string): Promise<Template>`

  From `kiosk/src/screens.tsx`: `export function CompositePreview({ src, template, maxW, maxH })`.

The kiosk has no UI test framework. Verify with `npm run build --prefix kiosk` (tsc + vite build) and root `npm test`; the controller checks it in a browser afterwards.

- [ ] **Step 1: Agent client methods** (`kiosk/src/agent.ts`)

Add after the `call` function:

```ts
/** Like call(), for endpoints that answer with an image. */
async function callBlob(path: string, body: object): Promise<Blob> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `POST ${path} failed (${res.status})`);
  }
  return res.blob();
}
```

In the `agent` object, add after `fonts`:

```ts
  previewLayout: (t: Template) => callBlob("/layout-preview", templateBody(t)),
  testPrintLayout: (t: Template) => call<{ jobId: string }>("POST", "/layout-preview/print", templateBody(t)),
  exportLayout: (id: string) => call<object>("GET", `/templates/${id}/export`),
  importLayout: (bundle: object) => call<Template>("POST", "/layout-import", bundle),
  copyLayout: (sourceId: string, t: Template, name: string) =>
    call<Template>("POST", `/templates/${sourceId}/copy`, { name, template: templateBody(t) }),
```

- [ ] **Step 2: Let `CompositePreview` show any sheet** (`kiosk/src/screens.tsx`)

Replace the `CompositePreview` doc comment and signature, down to and including the line `const src = agentUrl(\`/captures/${captureId}/image?variant=composite\`);`, with:

```tsx
/**
 * A print-ready sheet (a guest's composite, or a layout preview), shown the
 * way the guest will hold it. A landscape layout is stored turned onto the
 * portrait sheet, so it's turned back here.
 */
export function CompositePreview({ src, template, maxW, maxH }: {
  src: string; template: Template; maxW: number; maxH: number;
}) {
  const landscape = template.printSize === "4x6" && template.cellWidthPx > template.cellHeightPx;
  // Strips come out two-up on a portrait 4x6 sheet, so the file is always portrait unless turned.
  const [aw, ah] = landscape ? [3, 2] : [2, 3];
  const scale = Math.min(maxW / aw, maxH / ah);
  const [w, h] = [Math.round(aw * scale), Math.round(ah * scale)];
```

The rest of the function (the `return (...)` using `src`) stays as it is.

Add above it:

```tsx
const compositeUrl = (captureId: string) => agentUrl(`/captures/${captureId}/image?variant=composite`);
```

Change both callers (lines 211 and 252) from `captureId={captureId}` to `src={compositeUrl(captureId)}`.

- [ ] **Step 3: Preview dialog, Test print and Save as new** (`kiosk/src/LayoutEditor.tsx`)

- Add `import { CompositePreview } from "./screens";` after the `./fonts` import.
- After `const [confirmDelete, setConfirmDelete] = useState(false);`, add:

```tsx
  const [preview, setPreview] = useState<string | null>(null); // object URL of the rendered sheet
  const [confirmPrint, setConfirmPrint] = useState(false);
  const [printNote, setPrintNote] = useState("");
```

- After the `save()` function, add:

```tsx
  /** The draft as booth-agent should see it: an unsaved new layout still needs a valid id and a name. */
  const draft = (): Template => ({ ...t, id: t.id || savedId.current || "draft", name: (t.name ?? "").trim() || "Draft" });

  async function openPreview() {
    setBusy(true);
    setError("");
    try {
      setPreview(URL.createObjectURL(await agent.previewLayout(draft())));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function closePreview() {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setConfirmPrint(false);
    setPrintNote("");
  }

  /** Uses a sheet of paper, so it takes a second tap. */
  async function testPrint() {
    if (!confirmPrint) {
      setConfirmPrint(true);
      return;
    }
    setBusy(true);
    try {
      await agent.testPrintLayout(draft());
      setPrintNote("Sent to the printer.");
    } catch (e) {
      setPrintNote((e as Error).message);
    } finally {
      setConfirmPrint(false);
      setBusy(false);
    }
  }

  /** Saves this draft as a separate new layout; the one being edited stays as it was. */
  async function saveAsNew() {
    const name = (t.name ?? "").trim();
    if (!name) {
      setError("Give the layout a name first.");
      return;
    }
    const newName = name === (initial.name ?? "").trim() ? `${name} copy` : name;
    setBusy(true);
    setError("");
    try {
      await agent.copyLayout(savedId.current, t, newName);
      onClose(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
```

- In the top bar, insert a Preview button between Redo and Save:

```tsx
        <button type="button" className="btn outline sm" disabled={busy} onClick={openPreview}>Preview</button>
```

  and a Save as new button right after Save. It's shown only once the layout exists on booth-agent:

```tsx
        {savedId.current && (
          <button type="button" className="btn outline sm" disabled={busy} onClick={saveAsNew}>Save as new</button>
        )}
```

- As the last child of the outer `<div className="editor">`, after the `editor-body` div, add the dialog:

```tsx
      {preview && (
        <div className="modal">
          <div className="modal-card col gap-24">
            <div className="panel-title">Preview: exactly what prints (sample photos)</div>
            <CompositePreview src={preview} template={t} maxW={1100} maxH={640} />
            {printNote && <div className="muted fs-24">{printNote}</div>}
            <div className="row gap-16">
              <button type="button" className="btn primary sm" disabled={busy} onClick={testPrint}>
                {confirmPrint ? "Tap again: prints 1 sheet" : "Test print"}
              </button>
              <button type="button" className="btn outline sm" disabled={busy} onClick={closePreview}>Close</button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Import and Export in Settings** (`kiosk/src/Operator.tsx`)

- In `SettingsTab`, after the `update` function, add:

```tsx
  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      const t = await agent.importLayout(JSON.parse(await file.text()));
      setTemplates(await agent.templates());
      setError("");
      setNote(`Imported "${t.name ?? t.id}".`);
    } catch (e) {
      setError(e instanceof SyntaxError ? "That file isn't a layout file." : (e as Error).message);
    }
  }

  async function exportLayout(t: Template) {
    try {
      const bundle = await agent.exportLayout(t.id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${t.id}.kachak-layout.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNote(`Exported "${t.name ?? t.id}" to Downloads.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
```

- Add `const [note, setNote] = useState("");` beside the other `useState` calls in `SettingsTab`.
- Replace the `New layout` header row with:

```tsx
        <div className="row between">
          <div className="display fs-36">Layout</div>
          <div className="row gap-16">
            <label className="btn outline sm file-btn">
              Import
              <input type="file" accept=".json,application/json"
                onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            <button type="button" className="btn primary sm" onClick={() => onEdit(newTemplate(), templates, settings.templateId)}>
              New layout
            </button>
          </div>
        </div>
        {note && <div className="muted fs-24">{note}</div>}
```

- In each layout card, replace the single Edit button with a column of two:

```tsx
              <div className="col gap-6">
                <button type="button" className="btn outline row-btn" onClick={() => onEdit(t, templates, settings.templateId)}>
                  Edit
                </button>
                <button type="button" className="btn outline row-btn" onClick={() => exportLayout(t)}>
                  Export
                </button>
              </div>
```

- [ ] **Step 5: Styles** (`kiosk/src/styles.css`, at the end)

```css
/* Layout preview dialog, over the whole operator stage. */
.modal { position: absolute; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; background: rgba(21, 18, 26, 0.88); }
.modal-card { padding: 36px 44px; border-radius: 28px; background: var(--surface); align-items: center; }
/* Eight top-bar buttons have to fit beside the name field. */
.editor-top .btn.sm { padding: 0 28px; font-size: 26px; }
```

- [ ] **Step 6: Docs** (`kiosk/README.md`)

After the `**Layout editor:**` paragraph, add:

```markdown
**Preview and test print:** Preview renders the layout on booth-agent with numbered sample photos, so it is exactly what prints. From the preview, Test print sends one sheet to the printer (tap twice; it uses paper, and nothing is uploaded). **Save as new** stores the current draft as a separate layout ("<name> copy" unless you renamed it). In Settings, **Export** saves a layout and its images to one `.kachak-layout.json` file in Downloads, and **Import** loads such a file as a new layout.
```

- [ ] **Step 7: Build and test**

Run: `npm run build --prefix kiosk`
Expected: tsc and vite build pass.

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add kiosk/src/agent.ts kiosk/src/screens.tsx kiosk/src/LayoutEditor.tsx kiosk/src/Operator.tsx kiosk/src/styles.css kiosk/README.md
git commit -m "feat(kiosk): layout preview, test print, save as new, import/export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Browser check, ship and deploy (controller)

Not dispatched to a subagent. Every step that affects the booth (push, merge, restart, a real test print) needs the user's go-ahead.

- [ ] **Step 1: Agent on a spare port, kiosk dev against it.**
  - Before the live agent runs the new code, build the branch into a scratch copy and run it on port 7071, with a copy of `booth.config.json` whose `agent.port` is 7071 and whose `printing.hotFolderPath` is a scratch folder. That way a test print lands in the scratch folder, not the printer.
  - Run the kiosk dev server with `VITE_AGENT_URL=http://127.0.0.1:7071`.
  - Temporarily raise `IDLE_MS` (never commit it), click by element ref, confirm the screen before every click, and ask the user not to click in the pane.
- [ ] **Step 2: Exercise the new features.**
  1. Preview a new unsaved layout, then an existing one with an image. The sheet matches the editor, and landscape shows upright.
  2. Test print, tapping twice. A JPEG appears in the scratch hot folder.
  3. Save as new: a "… copy" layout appears in the list, with its own image.
  4. Export a layout and import the file: a "-2" layout appears.
  5. Delete the test layouts, stop the scratch agent, and revert `IDLE_MS`.
- [ ] **Step 3: Ship.**
  - Push and open the PR; wait for green CI; merge after the user says so.
  - Deploy the agent: `git pull && npm run build`, then the user restarts the service. Verify that `GET /health/preflight` `ranAt` changed and that `POST /layout-preview` answers.
  - Deploy the kiosk with the steps in `kiosk/README.md`, then the user reloads it.
  - Ask the user whether to make one real test print on the booth printer (it uses 1 sheet).
