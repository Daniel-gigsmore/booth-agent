# Layout Elements PR 2 (kiosk editor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the kiosk into the booth-agent repo and rewrite its layout editor so the operator can place photos, images, text and shapes. Each element gets exact X/Y/W/H, rotation, alignment, layers, and undo/redo. The last step is removing the agent's PR 1 compatibility fields once the new kiosk is live.

**Architecture:**
- The kiosk source moves from `C:\BoothAgent\kiosk` into `kiosk/` in this repo. Deployment copies it back there and builds in place, so the kiosk's `.env.local` and `node_modules` stay where they are.
- All layout-editing logic becomes pure functions in `kiosk/src/layout.ts`, tested by the root vitest run.
- The React side splits in three:
  - `LayoutEditor.tsx`: state, canvas and top bar.
  - `EditorPanels.tsx`: the Add, Selected and Layers panels.
  - `fonts.ts`: loads the agent's bundled fonts into the page.

**Tech Stack:**
- Kiosk: React 18, TypeScript 5 (strict), Vite 5, no test framework of its own.
- Agent: Express/TypeScript, with vitest 5 at the repo root.

**Spec:** `docs/superpowers/specs/2026-09-24-layout-elements-design.md` (section 3, "Kiosk editor"; PR 3 items are out of scope). The PR 1 plan (`docs/superpowers/plans/2026-09-24-layout-elements-pr1.md`) describes the agent API this builds on.

## Global Constraints

- Everything the operator sees is drawn on the kiosk's fixed 1920x1080 stage (`.stage`, scaled by `main.tsx`). The operator panel content area is about 1776x840 px. The kiosk is a touchscreen, so every control must be at least 44 px.
- Agent API, deployed with PR 1:
  - Templates are `{ id, name?, printSize, cellWidthPx, cellHeightPx, background, elements[] }`. Element types are `photo {shot}`, `image {file}`, `text {text, font, size, color, align, bold}` and `rect {fill, radius, opacity}`. Every element has `id, x, y, width, height, rotation, hidden`.
  - Other endpoints: `POST /templates/:id/assets` (PNG/JPEG body, returns `{ file }`), `GET /templates/:id/assets/:file`, `GET /fonts`, `GET /fonts/:file`.
- Limits the agent enforces:
  - Colours are `#rrggbb`.
  - At most 40 elements.
  - 1 to 12 shots, numbered 0..n-1 with no gaps.
  - Text is at most 500 characters; `size` is 8 to 600.
  - `width` and `height` are 1 to 3600.
  - `rotation` is -180 to 180.
- Until Task 6 ships, agent responses also carry derived `photoSlots` and `overlayFile`. **The kiosk must never send those back**: the agent treats any body with `photoSlots` as old-format and drops every non-photo element.
- Text variables are `{event}`, `{date}`, `{time}` and `{code}`. In the editor they show sample values: `{event}` from `VITE_EVENT_NAME`, `{date}`/`{time}` as now, formatted like `24 Sep 2026` and `14:05`, and `{code}` as `a1b2c3d4`.
- Rotation is clockwise for positive angles, the same as CSS `rotate()` and the agent's renderer.
- Never commit `kiosk/.env.local` or `booth.config.json*`. The kiosk's own `.gitignore` covers `*.local` and `.env`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in `C:\Users\User\Documents\booth-agent` on branch `feat/kiosk-editor`. Don't run the agent's `npm run build` there: the live service runs `dist/` from that checkout.

## File Structure

| File | Responsibility |
|---|---|
| `kiosk/**` (new, imported) | Kiosk source, moved from `C:\BoothAgent\kiosk` |
| `kiosk/src/layout.ts` (new) | Pure layout-editing logic: element creation, geometry, layers, paper change, sample text, save body, undo history |
| `kiosk/src/layout.test.ts` (new) | Its tests (run by the root `npm test`) |
| `kiosk/src/agent.ts` | Element types; `uploadAsset`, `fonts`; `saveTemplate` sends only stored fields |
| `kiosk/src/fonts.ts` (new) | Loads the agent's fonts as `FontFace`s |
| `kiosk/src/EditorPanels.tsx` (new) | Add, Selected (properties) and Layers panels, plus colour and number fields |
| `kiosk/src/LayoutEditor.tsx` (rewrite) | Editor state, canvas, drag and resize, top bar; `LayoutThumb` |
| `kiosk/src/Operator.tsx`, `kiosk/src/screens.tsx` | Use `shotCount()` instead of `photoSlots` |
| `kiosk/src/styles.css` | Editor styles |
| `.github/workflows/ci.yml` | Also builds the kiosk |
| `src/compositor/template.ts`, `src/server/routes.ts`, tests, `README.md` | Task 6: remove the PR 1 compatibility layer |

---

### Task 1: Move the kiosk into the repo

**Files:**
- Create: `kiosk/` (copied from `C:\BoothAgent\kiosk`: `src/`, `.env.example`, `.gitignore`, `README.md`, `index.html`, `package.json`, `package-lock.json`, `start-kiosk.ps1`, `tsconfig.json`)
- Modify: `kiosk/tsconfig.json`, `kiosk/README.md`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Produces: `kiosk/` builds with `npm ci --prefix kiosk && npm run build --prefix kiosk`. Kiosk test files (`kiosk/src/**/*.test.ts`) are excluded from the kiosk's own `tsc` and run under the root vitest.

- [ ] **Step 1: Create the branch and copy the source**

```bash
cd /c/Users/User/Documents/booth-agent
git checkout master && git pull
git checkout -b feat/kiosk-editor
mkdir -p kiosk
cd /c/BoothAgent/kiosk
cp -r .env.example .gitignore README.md index.html package.json package-lock.json start-kiosk.ps1 tsconfig.json src /c/Users/User/Documents/booth-agent/kiosk/
cd /c/Users/User/Documents/booth-agent
ls -a kiosk
```

Expected: exactly the files listed above plus `src/`. There must be no `.env.local`, `node_modules` or `dist`.

- [ ] **Step 2: Exclude kiosk tests from the kiosk's own typecheck**

The kiosk doesn't depend on vitest; its tests run from the repo root. In `kiosk/tsconfig.json`, after `"include": ["src"]`, add:

```json
  "exclude": ["src/**/*.test.ts"]
```

(Add a comma after `"include": ["src"]`.)

- [ ] **Step 3: Build the kiosk in CI**

In `.github/workflows/ci.yml`, in the `test-matrix` job, after `- run: npm run build`, add:

```yaml
      - run: npm ci --prefix kiosk
      - run: npm run build --prefix kiosk
```

- [ ] **Step 4: Document where the kiosk lives and how it is deployed**

In the root `README.md`, add this paragraph as the first paragraph after the title and intro, before the table of contents or first `##` heading:

```markdown
The guest-facing touchscreen UI lives in [`kiosk/`](kiosk/) (React + Vite). It is deployed to `C:\BoothAgent\kiosk` on the booth PC; see `kiosk/README.md`.
```

In `kiosk/README.md`, add this section at the end:

````markdown
## Deploying to the booth PC

The source lives in the booth-agent repo; the booth PC serves the build from `C:\BoothAgent\kiosk`, which keeps its own `.env.local` (with the shared secret) and `node_modules`. Deploy the agent first if the kiosk needs a newer agent. Then, from PowerShell in the repo root:

```powershell
robocopy kiosk\src C:\BoothAgent\kiosk\src /MIR
Copy-Item kiosk\index.html, kiosk\package.json, kiosk\package-lock.json, kiosk\tsconfig.json, kiosk\start-kiosk.ps1, kiosk\README.md, kiosk\.env.example C:\BoothAgent\kiosk\
cd C:\BoothAgent\kiosk
npm install
npm run build
```

`/MIR` is only used on `src\`, which holds no secrets. Never mirror the whole folder: it would delete `.env.local`. `vite preview` serves the new `dist\` straight away; reload the kiosk page (Ctrl+R, or Alt+F4 and reopen the "Kachak Kiosk" shortcut).
````

- [ ] **Step 5: Verify the kiosk builds from the repo**

Run: `npm ci --prefix kiosk && npm run build --prefix kiosk`
Expected: `tsc --noEmit` passes, and `vite build` prints `✓ built in …`. `kiosk/dist` and `kiosk/node_modules` are created and are ignored.

Run: `git status --short`
Expected: only `kiosk/…` source files, `.github/workflows/ci.yml` and `README.md`. No `node_modules`, `dist` or `.env.local`.

- [ ] **Step 6: Commit**

```bash
git add kiosk .github/workflows/ci.yml README.md
git status --short   # re-check: nothing under node_modules/dist/.env.local staged
git commit -m "chore: move the kiosk into the repo under kiosk/

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Element types and pure editing logic

**Files:**
- Modify: `kiosk/src/agent.ts`
- Create: `kiosk/src/layout.ts`
- Test: `kiosk/src/layout.test.ts`

**Interfaces:**
- Produces, from `kiosk/src/agent.ts`:
  - `type PrintSize`
  - `type PhotoElement`, `ImageElement`, `TextElement`, `RectElement`, `LayoutElement`
  - `interface Template { id; name?; printSize; cellWidthPx; cellHeightPx; background; elements: LayoutElement[] }`
  - `interface BundledFont { family: string; file: string; hasBold: boolean }`
  - `agent.uploadAsset(id: string, file: Blob): Promise<{ file: string }>`
  - `agent.fonts(): Promise<BundledFont[]>`
  - `agent.saveTemplate(t: Template): Promise<Template>`, which sends `templateBody(t)`
  - `Slot` and `agent.uploadOverlay` are removed.
- Produces, from `kiosk/src/layout.ts`:
  - Constants: `PAPERS`, `SNAP`, `MIN_SIZE`, `MAX_SIZE`, `MAX_SHOTS`, `MAX_ELEMENTS`, `VARIABLES`, `HISTORY_LIMIT`
  - `snap`, `clamp`, `paperOf`, `shotCount`, `newTemplate`, `newId`
  - `type AddKind = "photo" | "text" | "rect"`, `canAdd(t, kind: AddKind | "image")`, `addElement(t, kind): { template; id }`, `addImage(t, file, naturalWidth, naturalHeight): { template; id }`
  - `updateElement(t, id, patch)`, `compactShots(elements)`, `canRemove(t, id)`, `removeElement(t, id)`, `moveLayer(t, id, dir: 1 | -1)`
  - `type Edge`, `alignPatch(el, edge, t)`, `fillPatch(t)`, `movedBox(start, dx, dy, t)`, `resizedBox(start, dx, dy, lock)`, `sizePatch(el, key, value, lock)`, `normalizeAngle(deg)`
  - `changePaper(t, key)`, `sampleText(text, eventName, now?)`, `templateBody(t)`, `elementLabel(el)`
  - `interface History { past; present; future }`, `historyOf`, `historyCommit`, `historyReplace`, `historyCommitFrom`, `historyUndo`, `historyRedo`

After this task the kiosk's `tsc` fails in `LayoutEditor.tsx`, `Operator.tsx` and `screens.tsx`, which still use `photoSlots`. That is expected; Task 3 fixes them. In this task, run only the layout tests.

- [ ] **Step 1: Write the failing tests**

Create `kiosk/src/layout.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { LayoutElement, Template } from "./agent";
import {
  addElement, addImage, alignPatch, canAdd, canRemove, changePaper, compactShots, elementLabel, fillPatch,
  historyCommit, historyCommitFrom, historyOf, historyRedo, historyReplace, historyUndo, HISTORY_LIMIT,
  MAX_SHOTS, movedBox, moveLayer, newId, newTemplate, normalizeAngle, removeElement, resizedBox,
  sampleText, shotCount, sizePatch, templateBody, updateElement,
} from "./layout";

const base = { rotation: 0, hidden: false };
const photo = (id: string, shot: number, x = 0): LayoutElement => ({ ...base, id, type: "photo", shot, x, y: 0, width: 300, height: 200 });
const rect = (id: string): LayoutElement => ({ ...base, id, type: "rect", fill: "#ff0000", radius: 0, opacity: 1, x: 0, y: 0, width: 100, height: 100 });
const layout = (elements: LayoutElement[]): Template => ({
  id: "t", name: "T", printSize: "4x6", cellWidthPx: 1800, cellHeightPx: 1200, background: "#ffffff", elements,
});

describe("new layouts and elements", () => {
  it("starts with 4 photos and even 40/60 px margins", () => {
    const t = newTemplate();
    expect(shotCount(t)).toBe(4);
    const ys = t.elements.map((e) => e.y);
    expect(Math.min(...ys)).toBe(40);
    expect(Math.max(...t.elements.map((e) => e.y + e.height))).toBe(1160);
    expect(Math.min(...t.elements.map((e) => e.x))).toBe(60);
    expect(Math.max(...t.elements.map((e) => e.x + e.width))).toBe(1740);
  });

  it("makes unused ids", () => {
    expect(newId(layout([photo("photo-1", 0), photo("photo-2", 1)]), "photo")).toBe("photo-3");
    expect(newId(layout([photo("photo-2", 0)]), "photo")).toBe("photo-1");
  });

  it("adds a photo taking the next shot, a text and a shape on top", () => {
    let t = layout([photo("photo-1", 0)]);
    const p = addElement(t, "photo");
    expect(p.template.elements.at(-1)).toMatchObject({ id: p.id, type: "photo", shot: 1 });
    t = p.template;
    const text = addElement(t, "text");
    expect(text.template.elements.at(-1)).toMatchObject({ type: "text", text: "{event}", font: "Manrope" });
    const shape = addElement(t, "rect");
    expect(shape.template.elements.at(-1)).toMatchObject({ type: "rect", fill: "#f26b3a" });
  });

  it("stops adding photos at 12 shots and elements at 40", () => {
    const twelve = layout(Array.from({ length: MAX_SHOTS }, (_, i) => photo(`p${i}`, i)));
    expect(canAdd(twelve, "photo")).toBe(false);
    expect(canAdd(twelve, "text")).toBe(true);
    const forty = layout([photo("p", 0), ...Array.from({ length: 39 }, (_, i) => rect(`r${i}`))]);
    expect(canAdd(forty, "image")).toBe(false);
  });

  it("adds an image a third of the cell, keeping its shape", () => {
    const { template, id } = addImage(layout([photo("p", 0)]), "t-abc.png", 1000, 500);
    const el = template.elements.find((e) => e.id === id)!;
    expect(el).toMatchObject({ type: "image", file: "t-abc.png", width: 600, height: 300 });
  });
});

describe("editing elements", () => {
  it("renumbers shots so re-assigning a photo leaves no gap", () => {
    const t = layout([photo("a", 0), photo("b", 1), photo("c", 2)]);
    const moved = updateElement(t, "b", { shot: 0 });
    expect(moved.elements.map((e) => (e.type === "photo" ? e.shot : -1))).toEqual([0, 0, 1]);
    expect(compactShots([photo("x", 3), photo("y", 1)]).map((e) => (e.type === "photo" ? e.shot : -1))).toEqual([1, 0]);
  });

  it("won't remove the last photo, and compacts shots after a removal", () => {
    const one = layout([photo("a", 0), rect("r")]);
    expect(canRemove(one, "a")).toBe(false);
    expect(removeElement(one, "a")).toBe(one);
    expect(removeElement(one, "r").elements).toHaveLength(1);
    const three = layout([photo("a", 0), photo("b", 1), photo("c", 2)]);
    expect(shotCount(removeElement(three, "b"))).toBe(2);
  });

  it("moves layers up and down within bounds", () => {
    const t = layout([photo("a", 0), rect("r")]);
    expect(moveLayer(t, "a", 1).elements.map((e) => e.id)).toEqual(["r", "a"]);
    expect(moveLayer(t, "r", 1)).toBe(t);
    expect(moveLayer(t, "a", -1)).toBe(t);
  });

  it("aligns to the paper edges and centre, and fills the paper", () => {
    const t = layout([photo("a", 0)]);
    const el = t.elements[0]!;
    expect(alignPatch(el, "left", t)).toEqual({ x: 0 });
    expect(alignPatch(el, "hcenter", t)).toEqual({ x: 750 });
    expect(alignPatch(el, "right", t)).toEqual({ x: 1500 });
    expect(alignPatch(el, "top", t)).toEqual({ y: 0 });
    expect(alignPatch(el, "vcenter", t)).toEqual({ y: 500 });
    expect(alignPatch(el, "bottom", t)).toEqual({ y: 1000 });
    expect(fillPatch(t)).toEqual({ x: 0, y: 0, width: 1800, height: 1200, rotation: 0 });
  });

  it("snaps drags and never lets a box leave the paper entirely", () => {
    const t = layout([]);
    const start = { x: 100, y: 100, width: 300, height: 200 };
    expect(movedBox(start, 13, 26, t)).toEqual({ x: 110, y: 130 });
    expect(movedBox(start, -5000, 5000, t)).toEqual({ x: -280, y: 1180 });
  });

  it("resizes keeping the shape when locked", () => {
    const start = { width: 300, height: 200 };
    expect(resizedBox(start, 100, 0, true)).toEqual({ width: 400, height: 267 });
    expect(resizedBox(start, 100, 55, false)).toEqual({ width: 400, height: 260 });
    expect(resizedBox(start, -1000, -1000, false)).toEqual({ width: 20, height: 20 });
    expect(resizedBox(start, 9000, 0, false).width).toBe(3600);
  });

  it("sets one side from a number field, scaling the other when locked", () => {
    const el = photo("a", 0);
    expect(sizePatch(el, "width", 600, true)).toEqual({ width: 600, height: 400 });
    expect(sizePatch(el, "height", 100, true)).toEqual({ height: 100, width: 150 });
    expect(sizePatch(el, "width", 5, false)).toEqual({ width: 20 });
  });

  it("keeps angles within -180..180", () => {
    expect(normalizeAngle(195)).toBe(-165);
    expect(normalizeAngle(-190)).toBe(170);
    expect(normalizeAngle(90)).toBe(90);
  });

  it("scales every element, and text size, when the paper changes", () => {
    const text: LayoutElement = { ...base, id: "t", type: "text", text: "Hi", font: "Manrope", size: 90, color: "#000000", align: "center", bold: false, x: 180, y: 120, width: 900, height: 300 };
    const t = changePaper(layout([photo("a", 0), text]), "strip");
    expect(t).toMatchObject({ printSize: "2x6-strip", cellWidthPx: 600, cellHeightPx: 1800 });
    expect(t.elements[1]).toMatchObject({ x: 60, y: 180, width: 300, height: 450, size: 30 });
  });
});

describe("text, save body and labels", () => {
  it("fills sample variables", () => {
    expect(sampleText("{event} · {date} {time} #{code} {x}", "Gigsmore Launch", new Date(2026, 8, 4, 9, 5))).toBe(
      "Gigsmore Launch · 4 Sep 2026 09:05 #a1b2c3d4 {x}"
    );
    expect(sampleText("{event}", "")).toBe("Event name");
  });

  it("sends only the fields the agent stores", () => {
    const fromApi = { ...layout([photo("a", 0)]), photoSlots: [{ x: 0, y: 0, width: 1, height: 1 }], overlayFile: null };
    const body = templateBody(fromApi);
    expect(Object.keys(body).sort()).toEqual(["background", "cellHeightPx", "cellWidthPx", "elements", "id", "name", "printSize"]);
  });

  it("labels elements for the layers list", () => {
    expect(elementLabel(photo("a", 1))).toBe("Photo 2");
    expect(elementLabel(rect("r"))).toBe("Shape");
    const text: LayoutElement = { ...base, id: "t", type: "text", text: "Gigsmore Launch Party 2026", font: "Manrope", size: 40, color: "#000000", align: "center", bold: false, x: 0, y: 0, width: 10, height: 10 };
    expect(elementLabel(text)).toBe("Text: Gigsmore Launch Pa…");
  });
});

describe("undo history", () => {
  const a = layout([photo("a", 0)]);
  const b = layout([photo("b", 0)]);
  const c = layout([photo("c", 0)]);

  it("undoes and redoes commits", () => {
    let h = historyCommit(historyCommit(historyOf(a), b), c);
    h = historyUndo(h);
    expect(h.present).toBe(b);
    h = historyUndo(h);
    expect(h.present).toBe(a);
    expect(historyUndo(h)).toBe(h);
    h = historyRedo(h);
    expect(h.present).toBe(b);
    expect(historyCommit(h, c).future).toEqual([]);
  });

  it("replaces without an undo step, and records a whole drag as one step", () => {
    const h = historyReplace(historyReplace(historyOf(a), b), c);
    expect(h.past).toEqual([]);
    const dragged = historyCommitFrom(h, a);
    expect(dragged.past).toEqual([a]);
    expect(dragged.present).toBe(c);
    expect(historyCommitFrom(dragged, dragged.present)).toBe(dragged);
  });

  it("keeps at most HISTORY_LIMIT undo steps", () => {
    let h = historyOf(a);
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) h = historyCommit(h, layout([photo(`p${i}`, 0)]));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run kiosk/src/layout.test.ts`
Expected: FAIL, because `./layout` can't be resolved.

- [ ] **Step 3: Update the types in `kiosk/src/agent.ts`**

Replace the block from `export type PrintSize` down to the end of `interface Template`, which includes `Slot`, with:

```ts
export type PrintSize = "4x6" | "2x6-strip";

/** Every element is a box in cell pixels; x/y is the top-left of the unrotated box. */
interface Box { id: string; x: number; y: number; width: number; height: number; rotation: number; hidden: boolean }
export type PhotoElement = Box & { type: "photo"; shot: number };
export type ImageElement = Box & { type: "image"; file: string };
export type TextElement = Box & {
  type: "text"; text: string; font: string; size: number; color: string; align: "left" | "center" | "right"; bold: boolean;
};
export type RectElement = Box & { type: "rect"; fill: string; radius: number; opacity: number };
export type LayoutElement = PhotoElement | ImageElement | TextElement | RectElement;

/** A print layout: a background and elements in layer order (first = bottom). Each distinct photo shot is one photo per guest. */
export interface Template {
  id: string;
  name?: string;
  printSize: PrintSize;
  cellWidthPx: number;
  cellHeightPx: number;
  background: string;
  elements: LayoutElement[];
}

/** A font booth-agent bundles for text elements. */
export interface BundledFont { family: string; file: string; hasBold: boolean }
```

Add at the top of `agent.ts`, after the file comment:

```ts
import { templateBody } from "./layout";
```

In the `agent` object, replace the `saveTemplate` and `uploadOverlay` lines with:

```ts
  saveTemplate: (t: Template) => call<Template>("POST", `/templates/${t.id}`, templateBody(t)),
  uploadAsset: (id: string, file: Blob) => call<{ file: string }>("POST", `/templates/${id}/assets`, file),
  fonts: () => call<{ fonts: BundledFont[] }>("GET", "/fonts").then((r) => r.fonts),
```

- [ ] **Step 4: Implement `kiosk/src/layout.ts`**

```ts
// Layout editing as plain functions over Template, so it can be tested
// without a browser. The editor (LayoutEditor.tsx) only wires these to the UI.
import type { LayoutElement, PhotoElement, Template } from "./agent";

/** Paper choices. A landscape 4R layout is turned onto the sheet by booth-agent at print time. */
export const PAPERS = [
  { key: "4r-landscape", label: "4R landscape", printSize: "4x6", w: 1800, h: 1200 },
  { key: "4r-portrait", label: "4R portrait", printSize: "4x6", w: 1200, h: 1800 },
  { key: "strip", label: "2×6 strips", printSize: "2x6-strip", w: 600, h: 1800 },
] as const;

export const SNAP = 10;
export const MIN_SIZE = 20;
/** booth-agent rejects boxes larger than this. */
export const MAX_SIZE = 3600;
export const MAX_SHOTS = 12;
export const MAX_ELEMENTS = 40;
export const VARIABLES = ["{event}", "{date}", "{time}", "{code}"] as const;

export const snap = (v: number) => Math.round(v / SNAP) * SNAP;
export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const side = (v: number) => clamp(snap(v), MIN_SIZE, MAX_SIZE);

export const paperOf = (t: Pick<Template, "printSize" | "cellWidthPx" | "cellHeightPx">) =>
  PAPERS.find((p) => p.printSize === t.printSize && p.w === t.cellWidthPx && p.h === t.cellHeightPx) ?? PAPERS[0];

/** How many photos a guest takes: the highest shot number + 1. */
export function shotCount(t: Pick<Template, "elements">): number {
  return Math.max(0, ...t.elements.map((e) => (e.type === "photo" ? e.shot + 1 : 0)));
}

const box = (id: string, x: number, y: number, width: number, height: number) => ({
  id, x, y, width, height, rotation: 0, hidden: false,
});

/** A 4R landscape 2x2 grid with even margins: 60 px across, 40 px down. */
export function newTemplate(): Template {
  const photo = (shot: number, x: number, y: number): PhotoElement => ({
    ...box(`photo-${shot + 1}`, x, y, 810, 540), type: "photo", shot,
  });
  return {
    id: "", name: "", printSize: "4x6", cellWidthPx: 1800, cellHeightPx: 1200, background: "#ffffff",
    elements: [photo(0, 60, 40), photo(1, 930, 40), photo(2, 60, 620), photo(3, 930, 620)],
  };
}

/** An element id the layout doesn't use yet: `<prefix>-1`, `<prefix>-2`, … */
export function newId(t: Template, prefix: string): string {
  const taken = new Set(t.elements.map((e) => e.id));
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

export type AddKind = "photo" | "text" | "rect";

export function canAdd(t: Template, kind: AddKind | "image"): boolean {
  if (t.elements.length >= MAX_ELEMENTS) return false;
  return kind !== "photo" || shotCount(t) < MAX_SHOTS;
}

const withElement = (t: Template, el: LayoutElement) => ({ template: { ...t, elements: [...t.elements, el] }, id: el.id });

/** Adds a new element on top. A photo takes the next shot. */
export function addElement(t: Template, kind: AddKind): { template: Template; id: string } {
  const W = t.cellWidthPx;
  const H = t.cellHeightPx;
  if (kind === "photo") {
    const width = snap(Math.min(W, H * 1.5) / 3);
    return withElement(t, { ...box(newId(t, "photo"), 30, 30, width, Math.round((width * 2) / 3)), type: "photo", shot: shotCount(t) });
  }
  if (kind === "text") {
    return withElement(t, {
      ...box(newId(t, "text"), 60, snap(H / 2 - 60), W - 120, 120),
      type: "text", text: "{event}", font: "Manrope", size: 80, color: "#222222", align: "center", bold: true,
    });
  }
  return withElement(t, { ...box(newId(t, "shape"), 30, 30, snap(W / 3), snap(H / 6)), type: "rect", fill: "#f26b3a", radius: 0, opacity: 1 });
}

/** Adds an uploaded image on top, a third of the cell wide or tall, keeping its shape. */
export function addImage(t: Template, file: string, naturalWidth: number, naturalHeight: number): { template: Template; id: string } {
  const scale = Math.min(t.cellWidthPx / 3 / naturalWidth, t.cellHeightPx / 3 / naturalHeight);
  const width = clamp(Math.round(naturalWidth * scale), MIN_SIZE, MAX_SIZE);
  const height = clamp(Math.round(naturalHeight * scale), MIN_SIZE, MAX_SIZE);
  return withElement(t, { ...box(newId(t, "image"), 30, 30, width, height), type: "image", file });
}

/**
 * Renumbers shots 0..n-1, keeping their order, so re-assigning or deleting a
 * photo never leaves a gap (booth-agent rejects gaps).
 */
export function compactShots(elements: LayoutElement[]): LayoutElement[] {
  const used = [...new Set(elements.flatMap((e) => (e.type === "photo" ? [e.shot] : [])))].sort((a, b) => a - b);
  return elements.map((e) => (e.type === "photo" ? { ...e, shot: used.indexOf(e.shot) } : e));
}

export function updateElement(t: Template, id: string, patch: Partial<LayoutElement>): Template {
  const elements = t.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as LayoutElement) : e));
  return { ...t, elements: "shot" in patch ? compactShots(elements) : elements };
}

/** The last photo can't go: a layout needs at least one. */
export function canRemove(t: Template, id: string): boolean {
  const el = t.elements.find((e) => e.id === id);
  return !!el && (el.type !== "photo" || t.elements.filter((e) => e.type === "photo").length > 1);
}

export function removeElement(t: Template, id: string): Template {
  if (!canRemove(t, id)) return t;
  return { ...t, elements: compactShots(t.elements.filter((e) => e.id !== id)) };
}

/** dir 1 = one layer up (drawn later, on top); -1 = one layer down. */
export function moveLayer(t: Template, id: string, dir: 1 | -1): Template {
  const i = t.elements.findIndex((e) => e.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= t.elements.length) return t;
  const elements = [...t.elements];
  [elements[i], elements[j]] = [elements[j]!, elements[i]!];
  return { ...t, elements };
}

export type Edge = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** Lines the (unrotated) box up with an edge or the centre of the paper. */
export function alignPatch(el: LayoutElement, edge: Edge, t: Template): { x: number } | { y: number } {
  const W = t.cellWidthPx;
  const H = t.cellHeightPx;
  switch (edge) {
    case "left": return { x: 0 };
    case "hcenter": return { x: Math.round((W - el.width) / 2) };
    case "right": return { x: W - el.width };
    case "top": return { y: 0 };
    case "vcenter": return { y: Math.round((H - el.height) / 2) };
    case "bottom": return { y: H - el.height };
  }
}

/** Covers the whole paper, e.g. for a frame or a background band. */
export function fillPatch(t: Template) {
  return { x: 0, y: 0, width: t.cellWidthPx, height: t.cellHeightPx, rotation: 0 };
}

type Rect = { x: number; y: number; width: number; height: number };

/** Where a dragged box lands: snapped, and never dragged fully off the paper. */
export function movedBox(start: Rect, dx: number, dy: number, t: Template): { x: number; y: number } {
  return {
    x: clamp(snap(start.x + dx), MIN_SIZE - start.width, t.cellWidthPx - MIN_SIZE),
    y: clamp(snap(start.y + dy), MIN_SIZE - start.height, t.cellHeightPx - MIN_SIZE),
  };
}

/** Size after dragging the corner handle. Locked keeps the shape the box had when the drag began. */
export function resizedBox(start: Pick<Rect, "width" | "height">, dx: number, dy: number, lock: boolean) {
  const width = side(start.width + dx);
  const height = lock ? clamp(Math.round((width * start.height) / start.width), MIN_SIZE, MAX_SIZE) : side(start.height + dy);
  return { width, height };
}

/** One side typed into a number field; locked scales the other side to keep the shape. */
export function sizePatch(el: Pick<Rect, "width" | "height">, key: "width" | "height", value: number, lock: boolean) {
  const v = clamp(Math.round(value), MIN_SIZE, MAX_SIZE);
  if (!lock) return { [key]: v } as { width: number } | { height: number };
  return key === "width"
    ? { width: v, height: clamp(Math.round((v * el.height) / el.width), MIN_SIZE, MAX_SIZE) }
    : { height: v, width: clamp(Math.round((v * el.width) / el.height), MIN_SIZE, MAX_SIZE) };
}

export function normalizeAngle(deg: number): number {
  return ((((Math.round(deg) + 180) % 360) + 360) % 360) - 180;
}

/** Switches paper, scaling every element (and text size) to the new cell. */
export function changePaper(t: Template, key: string): Template {
  const p = PAPERS.find((x) => x.key === key) ?? PAPERS[0];
  const sx = p.w / t.cellWidthPx;
  const sy = p.h / t.cellHeightPx;
  return {
    ...t,
    printSize: p.printSize,
    cellWidthPx: p.w,
    cellHeightPx: p.h,
    elements: t.elements.map((e) => {
      const scaled = { ...e, x: snap(e.x * sx), y: snap(e.y * sy), width: side(e.width * sx), height: side(e.height * sy) };
      return scaled.type === "text" ? { ...scaled, size: clamp(Math.round(scaled.size * Math.min(sx, sy)), 8, 600) } : scaled;
    }),
  };
}

// Spelled out: some browsers' en-GB short month for September is "Sept".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Text as the editor shows it: variables filled in the way a print made now would have them. */
export function sampleText(text: string, eventName: string, now: Date = new Date()): string {
  const vars = {
    event: eventName || "Event name",
    date: `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    code: "a1b2c3d4",
  };
  return text.replace(/\{(event|date|time|code)\}/g, (_m, k: keyof typeof vars) => vars[k]);
}

/**
 * Just the fields booth-agent stores. Its responses still carry the old
 * photoSlots/overlayFile fields, and sending those back would make it treat
 * the layout as old-format and drop every non-photo element.
 */
export function templateBody(t: Template): Template {
  const { id, name, printSize, cellWidthPx, cellHeightPx, background, elements } = t;
  return { id, name, printSize, cellWidthPx, cellHeightPx, background, elements };
}

export function elementLabel(el: LayoutElement): string {
  switch (el.type) {
    case "photo": return `Photo ${el.shot + 1}`;
    case "image": return "Image";
    case "rect": return "Shape";
    case "text": {
      const s = el.text.trim() || "(empty)";
      return `Text: ${s.length > 18 ? `${s.slice(0, 18)}…` : s}`;
    }
  }
}

export interface History { past: Template[]; present: Template; future: Template[] }
export const HISTORY_LIMIT = 50;

export const historyOf = (t: Template): History => ({ past: [], present: t, future: [] });

/** A new undo step; clears redo. */
export function historyCommit(h: History, next: Template): History {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

/** Changes the layout without an undo step (mid-drag, or a save's response). */
export function historyReplace(h: History, next: Template): History {
  return { ...h, present: next };
}

/** Records a finished gesture (a drag) as one undo step, back to where it began. */
export function historyCommitFrom(h: History, before: Template): History {
  if (h.present === before) return h;
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), present: h.present, future: [] };
}

export function historyUndo(h: History): History {
  const prev = h.past[h.past.length - 1];
  return prev ? { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] } : h;
}

export function historyRedo(h: History): History {
  const next = h.future[0];
  return next ? { past: [...h.past, h.present], present: next, future: h.future.slice(1) } : h;
}
```

- [ ] **Step 5: Run the tests and check they pass**

Run: `npx vitest run kiosk/src/layout.test.ts`
Expected: PASS.

Run: `npm test`
Expected: the whole root suite passes (agent tests unchanged, plus the new kiosk file).

- [ ] **Step 6: Commit**

```bash
git add kiosk/src/agent.ts kiosk/src/layout.ts kiosk/src/layout.test.ts
git commit -m "feat(kiosk): element types and pure layout-editing logic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The editor UI

**Files:**
- Create: `kiosk/src/fonts.ts`, `kiosk/src/EditorPanels.tsx`
- Rewrite: `kiosk/src/LayoutEditor.tsx`
- Modify: `kiosk/src/Operator.tsx`, `kiosk/src/screens.tsx`, `kiosk/src/styles.css`, `kiosk/README.md`

**Interfaces:**
- Consumes: everything Task 2 produces (`agent.ts` types and methods, `layout.ts` functions).
- Produces:
  - `useAgentFonts(): BundledFont[]` and `cssFamily(family: string): string` from `fonts.ts`
  - `AddPanel`, `PropsPanel`, `LayersPanel` and `ColorField` from `EditorPanels.tsx`
  - `LayoutThumb` and the default `LayoutEditor` from `LayoutEditor.tsx`. `newTemplate` is now imported from `./layout`.

The kiosk has no UI test framework. Verification is the kiosk's `tsc` + `vite build`; Task 4 exercises it in a browser.

- [ ] **Step 1: Create `kiosk/src/fonts.ts`**

```ts
import { useEffect, useState } from "react";
import { agent, agentUrl, BundledFont } from "./agent";

// Prefixed so a layout font never clashes with the kiosk's own UI fonts.
export const cssFamily = (family: string) => `"Layout ${family}", sans-serif`;

let loading: Promise<BundledFont[]> | null = null;

/** Registers booth-agent's bundled fonts once, so the editor draws text with the same files the print uses. */
function loadFonts(): Promise<BundledFont[]> {
  loading ??= agent.fonts().then((list) => {
    for (const f of list) {
      // One weight range per file: variable fonts cover it, and a single-weight
      // font is then used as-is for bold too, as booth-agent's renderer does.
      const face = new FontFace(`Layout ${f.family}`, `url(${agentUrl(`/fonts/${f.file}`)})`, { weight: "100 900" });
      document.fonts.add(face);
      face.load().catch(() => {});
    }
    return list;
  });
  loading.catch(() => {
    loading = null; // try again next time the editor opens
  });
  return loading;
}

export function useAgentFonts(): BundledFont[] {
  const [fonts, setFonts] = useState<BundledFont[]>([]);
  useEffect(() => {
    let live = true;
    loadFonts().then((list) => live && setFonts(list), () => {});
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}
```

- [ ] **Step 2: Create `kiosk/src/EditorPanels.tsx`**

```tsx
import { useRef, useState } from "react";
import type { BundledFont, LayoutElement, Template, TextElement } from "./agent";
import { cssFamily } from "./fonts";
import {
  AddKind, alignPatch, canAdd, canRemove, clamp, Edge, elementLabel, fillPatch, MAX_SHOTS, normalizeAngle,
  PAPERS, paperOf, shotCount, sizePatch, VARIABLES,
} from "./layout";

type Patch = Partial<LayoutElement>;

const SWATCHES = ["#ffffff", "#fbf8f3", "#222222", "#000000", "#f26b3a", "#ffd23f", "#2e6be6", "#3a7d44"];
const EDGES: [Edge, string][] = [
  ["left", "Left"], ["hcenter", "Centre"], ["right", "Right"], ["top", "Top"], ["vcenter", "Middle"], ["bottom", "Bottom"],
];

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="row gap-10 wrap">
        <input type="color" className="color-input" value={value} aria-label={`${label}: pick`} onChange={(e) => onChange(e.target.value)} />
        {SWATCHES.map((c) => (
          <button key={c} type="button" className={`swatch ${c === value.toLowerCase() ? "on" : ""}`}
            style={{ background: c }} aria-label={`${label}: ${c}`} onClick={() => onChange(c)} />
        ))}
      </div>
    </div>
  );
}

/** A number with −/+ buttons (no keyboard on the touchscreen). Typed values apply on blur or Enter. */
function NumberField({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() !== "" && Number.isFinite(Number(draft))) onChange(Number(draft));
    setDraft(null);
  };
  return (
    <div className="num-field">
      <span>{label}</span>
      <div className="row">
        <button type="button" className="num-btn" aria-label={`${label}: less`} onClick={() => onChange(value - step)}>−</button>
        <input type="number" value={draft ?? value} aria-label={label}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        <button type="button" className="num-btn" aria-label={`${label}: more`} onClick={() => onChange(value + step)}>+</button>
      </div>
    </div>
  );
}

export function AddPanel({ t, busy, onAdd, onImage, onPaper, onBackground }: {
  t: Template; busy: boolean; onAdd: (kind: AddKind) => void; onImage: (file: File | undefined) => void;
  onPaper: (key: string) => void; onBackground: (color: string) => void;
}) {
  const paper = paperOf(t);
  const shots = shotCount(t);
  const imageOk = !busy && canAdd(t, "image");
  return (
    <div className="editor-add">
      <div className="panel-title">Add</div>
      <button type="button" className="add-btn" disabled={!canAdd(t, "photo")} onClick={() => onAdd("photo")}>Photo</button>
      <label className={`add-btn file-btn ${imageOk ? "" : "disabled"}`}>
        Image
        {/* Clear the value so picking the same (edited) file again still fires onChange. */}
        <input type="file" accept="image/png,image/jpeg" disabled={!imageOk}
          onChange={(e) => { onImage(e.target.files?.[0]); e.target.value = ""; }} />
      </label>
      <button type="button" className="add-btn" disabled={!canAdd(t, "text")} onClick={() => onAdd("text")}>Text</button>
      <button type="button" className="add-btn" disabled={!canAdd(t, "rect")} onClick={() => onAdd("rect")}>Shape</button>
      <ColorField label="Background" value={t.background} onChange={onBackground} />
      <div className="field">
        <span>Paper</span>
        <div className="col gap-8">
          {PAPERS.map((p) => (
            <button key={p.key} type="button" className={`seg-btn ${p.key === paper.key ? "on" : ""}`} onClick={() => onPaper(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="muted fs-22">{shots} photo{shots === 1 ? "" : "s"} per guest</div>
    </div>
  );
}

function TextProps({ el, fonts, onPatch }: { el: TextElement; fonts: BundledFont[]; onPatch: (p: Patch) => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  function insert(v: string) {
    const a = area.current;
    const at = a ? a.selectionStart : el.text.length;
    const end = a ? a.selectionEnd : at;
    onPatch({ text: el.text.slice(0, at) + v + el.text.slice(end) });
  }
  return (
    <>
      <div className="field">
        <span>Text</span>
        <textarea ref={area} className="text-input" rows={2} maxLength={500} value={el.text}
          onChange={(e) => onPatch({ text: e.target.value })} />
        <div className="row gap-8 wrap">
          {VARIABLES.map((v) => <button key={v} type="button" className="chip" onClick={() => insert(v)}>{v}</button>)}
        </div>
      </div>
      <div className="field">
        <span>Font</span>
        <select className="text-input" value={el.font} style={{ fontFamily: cssFamily(el.font) }}
          onChange={(e) => onPatch({ font: e.target.value })}>
          {fonts.map((f) => <option key={f.family} value={f.family}>{f.family}</option>)}
          {!fonts.some((f) => f.family === el.font) && <option value={el.font}>{el.font}</option>}
        </select>
      </div>
      <div className="grid-2">
        <NumberField label="Size" value={el.size} step={4} onChange={(v) => onPatch({ size: clamp(Math.round(v), 8, 600) })} />
        <label className="check">
          <input type="checkbox" checked={el.bold} onChange={(e) => onPatch({ bold: e.target.checked })} />
          Bold
        </label>
      </div>
      <div className="seg self-start">
        {(["left", "center", "right"] as const).map((a) => (
          <button key={a} type="button" className={el.align === a ? "on" : ""} onClick={() => onPatch({ align: a })}>
            {a === "left" ? "Left" : a === "center" ? "Centre" : "Right"}
          </button>
        ))}
      </div>
      <ColorField label="Colour" value={el.color} onChange={(color) => onPatch({ color })} />
    </>
  );
}

export function PropsPanel({ el, t, fonts, lock, onLock, onPatch }: {
  el: LayoutElement | null; t: Template; fonts: BundledFont[]; lock: boolean;
  onLock: (v: boolean) => void; onPatch: (p: Patch) => void;
}) {
  if (!el) {
    return (
      <div className="panel col gap-10">
        <div className="panel-title">Selected</div>
        <div className="muted fs-22">Tap something on the layout or in Layers, or add something new.</div>
      </div>
    );
  }
  const shots = shotCount(t);
  return (
    <div className="panel col gap-16">
      <div className="panel-title">{elementLabel(el)}</div>
      <div className="grid-2">
        <NumberField label="X" value={el.x} step={10} onChange={(v) => onPatch({ x: Math.round(v) })} />
        <NumberField label="Y" value={el.y} step={10} onChange={(v) => onPatch({ y: Math.round(v) })} />
        <NumberField label="W" value={el.width} step={10} onChange={(v) => onPatch(sizePatch(el, "width", v, lock))} />
        <NumberField label="H" value={el.height} step={10} onChange={(v) => onPatch(sizePatch(el, "height", v, lock))} />
        <NumberField label="Rotate°" value={el.rotation} step={15} onChange={(v) => onPatch({ rotation: normalizeAngle(v) })} />
        <label className="check">
          <input type="checkbox" checked={lock} onChange={(e) => onLock(e.target.checked)} />
          Keep aspect ratio
        </label>
      </div>
      <div className="row gap-8 wrap">
        {EDGES.map(([edge, label]) => (
          <button key={edge} type="button" className="btn outline xs" onClick={() => onPatch(alignPatch(el, edge, t))}>{label}</button>
        ))}
        <button type="button" className="btn outline xs" onClick={() => onPatch(fillPatch(t))}>Fill paper</button>
      </div>
      {el.type === "photo" && (
        <div className="field">
          <span>Photo number</span>
          <div className="row gap-8 wrap">
            {Array.from({ length: Math.min(shots + 1, MAX_SHOTS) }, (_, i) => (
              <button key={i} type="button" className={`seg-btn ${el.shot === i ? "on" : ""}`} onClick={() => onPatch({ shot: i })}>
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      )}
      {el.type === "text" && <TextProps el={el} fonts={fonts} onPatch={onPatch} />}
      {el.type === "rect" && (
        <>
          <ColorField label="Fill" value={el.fill} onChange={(fill) => onPatch({ fill })} />
          <div className="grid-2">
            <NumberField label="Corner" value={el.radius} step={10} onChange={(v) => onPatch({ radius: Math.max(0, Math.round(v)) })} />
            <NumberField label="Opacity %" value={Math.round(el.opacity * 100)} step={10}
              onChange={(v) => onPatch({ opacity: clamp(Math.round(v), 0, 100) / 100 })} />
          </div>
        </>
      )}
    </div>
  );
}

export function LayersPanel({ t, selectedId, onSelect, onPatch, onMove, onDelete }: {
  t: Template; selectedId: string | null; onSelect: (id: string) => void;
  onPatch: (id: string, p: Patch) => void; onMove: (id: string, dir: 1 | -1) => void; onDelete: (id: string) => void;
}) {
  const top = t.elements.length - 1;
  return (
    <div className="panel col gap-6">
      <div className="panel-title">Layers <span className="muted fs-22">top first</span></div>
      {[...t.elements].reverse().map((el) => {
        const i = t.elements.indexOf(el);
        return (
          <div key={el.id} className={`layer ${el.id === selectedId ? "on" : ""} ${el.hidden ? "muted" : ""}`}>
            <button type="button" className="layer-name" onClick={() => onSelect(el.id)}>{elementLabel(el)}</button>
            <button type="button" className="icon-btn" onClick={() => onPatch(el.id, { hidden: !el.hidden })}>
              {el.hidden ? "Show" : "Hide"}
            </button>
            <button type="button" className="icon-btn" aria-label="Move up" disabled={i === top} onClick={() => onMove(el.id, 1)}>↑</button>
            <button type="button" className="icon-btn" aria-label="Move down" disabled={i === 0} onClick={() => onMove(el.id, -1)}>↓</button>
            <button type="button" className="icon-btn" aria-label="Delete" disabled={!canRemove(t, el.id)} onClick={() => onDelete(el.id)}>✕</button>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Rewrite `kiosk/src/LayoutEditor.tsx`**

Replace the whole file with:

```tsx
import { useRef, useState } from "react";
import { agent, agentUrl, config, LayoutElement, Template } from "./agent";
import { AddPanel, LayersPanel, PropsPanel } from "./EditorPanels";
import { cssFamily, useAgentFonts } from "./fonts";
import {
  addElement, addImage, AddKind, changePaper, History, historyCommit, historyCommitFrom, historyOf, historyRedo,
  historyReplace, historyUndo, moveLayer, movedBox, removeElement, resizedBox, sampleText, updateElement,
} from "./layout";

/** Small picture of a layout, for the Settings list. */
export function LayoutThumb({ t, height }: { t: Template; height: number }) {
  return (
    <svg height={height} viewBox={`0 0 ${t.cellWidthPx} ${t.cellHeightPx}`} className="layout-thumb" aria-hidden="true">
      <rect width={t.cellWidthPx} height={t.cellHeightPx} fill={t.background} />
      {t.elements.filter((e) => !e.hidden).map((e) => {
        const turn = e.rotation ? `rotate(${e.rotation} ${e.x + e.width / 2} ${e.y + e.height / 2})` : undefined;
        const at = { x: e.x, y: e.y, width: e.width, height: e.height };
        switch (e.type) {
          case "photo":
            return (
              <g key={e.id} transform={turn}>
                <rect {...at} fill="#3A3342" />
                <text x={e.x + e.width / 2} y={e.y + e.height / 2} fill="#F5EFE6" fontSize={Math.min(e.width, e.height) / 2.5}
                  fontWeight="800" textAnchor="middle" dominantBaseline="central">{e.shot + 1}</text>
              </g>
            );
          case "image":
            return <image key={e.id} {...at} transform={turn} preserveAspectRatio="none"
              href={agentUrl(`/templates/${t.id}/assets/${e.file}`)} />;
          case "rect":
            return <rect key={e.id} {...at} transform={turn} fill={e.fill} fillOpacity={e.opacity} rx={e.radius} />;
          case "text":
            // A bar where the text goes; the thumbnail is too small to read.
            return <rect key={e.id} x={e.x} y={e.y + e.height * 0.3} width={e.width} height={e.height * 0.4}
              transform={turn} fill={e.color} fillOpacity={0.5} rx={e.height * 0.1} />;
        }
      })}
    </svg>
  );
}

function slugFor(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "layout";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

const JUSTIFY = { left: "flex-start", center: "center", right: "flex-end" } as const;

/** One element as the editor draws it, filling its (already positioned and rotated) box. */
function ElementBody({ el, t, view }: { el: LayoutElement; t: Template; view: number }) {
  switch (el.type) {
    case "photo":
      return <div className="el-photo" style={{ fontSize: Math.min(el.width, el.height) * view / 2.5 }}>{el.shot + 1}</div>;
    case "image":
      return <img className="el-fill" src={agentUrl(`/templates/${t.id}/assets/${el.file}`)} alt="" draggable={false} />;
    case "rect":
      return <div className="el-fill" style={{ background: el.fill, opacity: el.opacity, borderRadius: el.radius * view }} />;
    case "text":
      return (
        <div className="el-text" style={{
          justifyContent: JUSTIFY[el.align], textAlign: el.align, color: el.color,
          fontFamily: cssFamily(el.font), fontSize: el.size * view, fontWeight: el.bold ? 700 : 400,
        }}>
          <span>{sampleText(el.text, config.eventName)}</span>
        </div>
      );
  }
}

type Drag = {
  id: string; mode: "move" | "resize"; startX: number; startY: number;
  start: LayoutElement; before: Template; pxPerCell: number;
};

export default function LayoutEditor({ initial, takenIds, inUseId, onClose }: {
  initial: Template; takenIds: string[]; inUseId: string; onClose: (changed: boolean) => void;
}) {
  const [h, setH] = useState<History>(() => historyOf(initial));
  const t = h.present;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lock, setLock] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Saves and uploads write to booth-agent at once, so the list needs a refresh even on Cancel.
  const [wrote, setWrote] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fonts = useAgentFonts();
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const isNew = initial.id === "";
  const selected = t.elements.find((e) => e.id === selectedId) ?? null;

  // The canvas gets a fixed area of the stage; cell pixels map onto it.
  const view = Math.min(960 / t.cellWidthPx, 680 / t.cellHeightPx);

  const change = (next: Template) => setH((cur) => historyCommit(cur, next));
  const patch = (id: string, p: Partial<LayoutElement>) => setH((cur) => historyCommit(cur, updateElement(cur.present, id, p)));

  function startDrag(e: React.PointerEvent, el: LayoutElement, mode: Drag["mode"]) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Measured on screen, so it already includes the stage's own scale-to-fit.
    const pxPerCell = canvas.current!.getBoundingClientRect().width / t.cellWidthPx;
    drag.current = { id: el.id, mode, startX: e.clientX, startY: e.clientY, start: el, before: t, pxPerCell };
    setSelectedId(el.id);
  }

  function moveDrag(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.pxPerCell;
    const dy = (e.clientY - d.startY) / d.pxPerCell;
    // Screen-space drag, even for a rotated box: simple, and the number fields give exact control.
    const p = d.mode === "move" ? movedBox(d.start, dx, dy, t) : resizedBox(d.start, dx, dy, lock);
    setH((cur) => historyReplace(cur, updateElement(cur.present, d.id, p)));
  }

  function endDrag() {
    const d = drag.current;
    drag.current = null;
    if (d) setH((cur) => historyCommitFrom(cur, d.before));
  }

  /** Saves and returns the stored layout (a new layout gets its id here). */
  async function save(): Promise<Template | null> {
    const name = (t.name ?? "").trim();
    if (!name) {
      setError("Give the layout a name first.");
      return null;
    }
    setBusy(true);
    setError("");
    try {
      const id = isNew && !t.id ? slugFor(name, takenIds) : t.id;
      const stored = await agent.saveTemplate({ ...t, id, name });
      setH((cur) => historyReplace(cur, stored));
      setWrote(true);
      return stored;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function add(kind: AddKind) {
    const r = addElement(t, kind);
    change(r.template);
    setSelectedId(r.id);
  }

  async function addImageFile(file: File | undefined) {
    if (!file) return;
    // Uploads are filed under the layout's id, so a new layout is saved first.
    const current = t.id ? t : await save();
    if (!current) return;
    setBusy(true);
    try {
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      const { file: name } = await agent.uploadAsset(current.id, file);
      setWrote(true);
      const r = addImage(current, name, width, height);
      setH((cur) => historyCommit(cur, r.template));
      setSelectedId(r.id);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeLayout() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await agent.deleteTemplate(t.id);
      onClose(true);
    } catch (e) {
      setError((e as Error).message);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="editor">
      <div className="row gap-16 editor-top">
        <input className="text-input grow" value={t.name ?? ""} maxLength={80} placeholder="Layout name, e.g. Wedding 4-up"
          aria-label="Layout name" onChange={(e) => setH((cur) => historyReplace(cur, { ...cur.present, name: e.target.value }))} />
        <button type="button" className="btn outline sm" disabled={!h.past.length} onClick={() => setH(historyUndo)}>Undo</button>
        <button type="button" className="btn outline sm" disabled={!h.future.length} onClick={() => setH(historyRedo)}>Redo</button>
        <button type="button" className="btn primary sm" disabled={busy} onClick={async () => { if (await save()) onClose(true); }}>
          Save
        </button>
        <button type="button" className="btn outline sm" onClick={() => onClose(wrote)}>Cancel</button>
        {!isNew && t.id !== inUseId && (
          <button type="button" className="btn outline sm danger" onClick={removeLayout}>
            {confirmDelete ? "Tap again to delete" : "Delete layout"}
          </button>
        )}
      </div>
      {error && <div className="banner error fs-24">{error}</div>}

      <div className="editor-body">
        <AddPanel t={t} busy={busy} onAdd={add} onImage={addImageFile}
          onPaper={(key) => change(changePaper(t, key))} onBackground={(background) => change({ ...t, background })} />

        <div className="editor-stage">
          <div
            ref={canvas}
            className="editor-canvas"
            style={{ width: t.cellWidthPx * view, height: t.cellHeightPx * view, background: t.background }}
            onPointerDown={() => setSelectedId(null)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {t.elements.map((el) => (
              <div
                key={el.id}
                className={`el ${el.id === selectedId ? "selected" : ""} ${el.hidden ? "hidden-el" : ""}`}
                style={{
                  left: el.x * view, top: el.y * view, width: el.width * view, height: el.height * view,
                  transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                }}
                onPointerDown={(e) => startDrag(e, el, "move")}
              >
                <ElementBody el={el} t={t} view={view} />
                {el.id === selectedId && (
                  <div className="editor-handle" aria-label="Resize" onPointerDown={(e) => startDrag(e, el, "resize")} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="editor-side">
          <PropsPanel el={selected} t={t} fonts={fonts} lock={lock} onLock={setLock}
            onPatch={(p) => selected && patch(selected.id, p)} />
          <LayersPanel t={t} selectedId={selectedId} onSelect={setSelectedId} onPatch={patch}
            onMove={(id, dir) => change(moveLayer(t, id, dir))}
            onDelete={(id) => {
              change(removeElement(t, id));
              if (id === selectedId) setSelectedId(null);
            }} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Point `Operator.tsx` and `screens.tsx` at the new model**

In `kiosk/src/Operator.tsx`:
- Replace `import LayoutEditor, { LayoutThumb, newTemplate } from "./LayoutEditor";` with:

```tsx
import LayoutEditor, { LayoutThumb } from "./LayoutEditor";
import { newTemplate, shotCount } from "./layout";
```

- Replace the photo-count line:

```tsx
                    {t.photoSlots.length} photo{t.photoSlots.length === 1 ? "" : "s"} · {t.printSize === "4x6" ? "4R" : "2×6 strips"}
```

with:

```tsx
                    {shotCount(t)} photo{shotCount(t) === 1 ? "" : "s"} · {t.printSize === "4x6" ? "4R" : "2×6 strips"}
```

In `kiosk/src/screens.tsx`:
- Add `import { shotCount } from "./layout";` after the existing imports.
- Replace `const total = session.template.photoSlots.length;` with `const total = shotCount(session.template);`.

- [ ] **Step 5: Replace the editor styles**

In `kiosk/src/styles.css`, delete every rule from `.editor { display: flex; gap: 48px; flex-grow: 1; min-height: 0; }` through `.editor-actions { margin-top: auto; }` (the old editor block, including `.field input…`, `.check`, `.file-btn` rules). Put this block in its place:

```css
.gap-8 { gap: 8px; } .gap-10 { gap: 10px; } .fs-22 { font-size: 22px; } .wrap { flex-wrap: wrap; }

.editor { display: flex; flex-direction: column; gap: 20px; flex-grow: 1; min-height: 0; }
.editor-body { display: flex; gap: 28px; flex-grow: 1; min-height: 0; }
.text-input {
  height: 72px;
  padding: 0 24px;
  border-radius: 16px;
  border: 2px solid var(--line);
  background: var(--surface);
  color: var(--text);
  font: 600 26px var(--body);
  user-select: text;
}
textarea.text-input { height: auto; padding: 14px 20px; resize: none; }
select.text-input { padding: 0 16px; }

.editor-add { width: 260px; flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.add-btn {
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  border: 2px solid var(--line);
  background: var(--surface);
  color: var(--text);
  font: 700 26px var(--body);
}
.add-btn:disabled, .add-btn.disabled { opacity: 0.4; }
.file-btn { position: relative; overflow: hidden; }
.file-btn input { position: absolute; inset: 0; opacity: 0; }

.editor-stage { width: 960px; flex-shrink: 0; display: flex; justify-content: center; align-items: flex-start; }
/* Clips like the print does: anything past the paper edge is cut off. */
.editor-canvas { position: relative; overflow: hidden; border-radius: 6px; touch-action: none; box-shadow: 0 30px 60px rgba(0, 0, 0, 0.45); }
.el { position: absolute; touch-action: none; transform-origin: center; }
.el.selected { outline: 3px solid var(--accent); }
.el.hidden-el { opacity: 0.35; }
.el-fill { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.el-photo {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(58, 51, 66, 0.85);
  color: var(--text);
  font-family: var(--display);
  font-weight: 800;
  pointer-events: none;
}
.el-text { position: absolute; inset: 0; display: flex; align-items: center; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.2; pointer-events: none; }
.editor-handle {
  position: absolute;
  right: -6px;
  bottom: -6px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--accent);
  border: 4px solid var(--paper);
  touch-action: none;
}

.editor-side { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 20px; overflow-y: auto; padding-right: 8px; }
.panel { padding: 20px 24px; border-radius: 20px; background: var(--surface); }
.panel-title { font-family: var(--display); font-weight: 800; font-size: 28px; color: var(--text); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; align-items: end; }
.field { display: flex; flex-direction: column; gap: 10px; font-size: 20px; font-weight: 700; letter-spacing: 0.04em; color: var(--muted); }
.num-field { display: flex; flex-direction: column; gap: 6px; font-size: 18px; font-weight: 700; color: var(--muted); }
.num-field input {
  width: 100%;
  min-width: 0;
  height: 56px;
  text-align: center;
  border: 2px solid var(--line);
  border-left: 0;
  border-right: 0;
  background: var(--bg);
  color: var(--text);
  font: 700 24px var(--body);
  user-select: text;
}
.num-btn { width: 56px; height: 56px; flex-shrink: 0; border: 2px solid var(--line); background: var(--bg); color: var(--text); font-size: 30px; }
.num-btn:first-child { border-radius: 12px 0 0 12px; }
.num-btn:last-child { border-radius: 0 12px 12px 0; }
.check { display: flex; align-items: center; gap: 14px; min-height: 56px; font-size: 22px; font-weight: 600; letter-spacing: 0; color: var(--text); }
.check input { width: 32px; height: 32px; accent-color: var(--accent); }
.btn.xs { height: 56px; padding: 0 20px; border-color: var(--line); font-family: var(--body); font-size: 22px; font-weight: 700; }
.seg-btn { height: 56px; min-width: 56px; padding: 0 16px; border-radius: 12px; border: 2px solid var(--line); background: var(--bg); color: var(--text); font: 700 22px var(--body); }
.seg-btn.on { background: var(--text); color: var(--bg); border-color: var(--text); }
.chip { height: 48px; padding: 0 16px; border-radius: 999px; border: 2px solid var(--line); background: var(--bg); color: var(--text); font: 700 20px var(--body); }
.color-input { width: 64px; height: 56px; padding: 0; border: 2px solid var(--line); border-radius: 12px; background: none; }
.swatch { width: 44px; height: 44px; border-radius: 50%; border: 3px solid var(--line); }
.swatch.on { border-color: var(--accent); }
.layer { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 12px; }
.layer.on { background: var(--bg); outline: 2px solid var(--accent); }
.layer-name {
  flex-grow: 1;
  min-width: 0;
  height: 52px;
  border: 0;
  background: none;
  color: inherit;
  text-align: left;
  font: 700 22px var(--body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.icon-btn { min-width: 52px; height: 52px; padding: 0 12px; border-radius: 12px; border: 2px solid var(--line); background: var(--bg); color: var(--text); font: 700 20px var(--body); }
.icon-btn:disabled { opacity: 0.35; }
```

Other screens don't use the removed `.field input…` rule. Check with `grep -n "field" kiosk/src/*.tsx`: only `EditorPanels.tsx` should use `field`.

- [ ] **Step 6: Update the kiosk README's editor paragraph**

In `kiosk/README.md`, replace the paragraph starting with `**Layout editor:**` with:

```markdown
**Layout editor:** the left column adds a photo (each photo number is one shot), an image (PNG or JPEG, uploaded to booth-agent), a text or a shape, and sets the background colour and paper. Drag an element to move it and its orange corner dot to resize it. The Selected panel has exact X/Y/W/H, rotation, keep-aspect-ratio, align-to-paper and "Fill paper" controls, plus text (font, size, colour, bold, alignment, and the `{event}` `{date}` `{time}` `{code}` variables filled in per print), shape and photo-number settings. The Layers panel lists elements top first, with show/hide, up/down and delete. Undo/Redo keep the last 50 steps. The editor draws text with booth-agent's own font files, so it looks like the print; line breaks may differ slightly.
```

Also replace `Requires booth-agent with the multi-photo layout and `/session` endpoints (booth-agent PR #40), plus the bundled layouts copied into `compositing.templateDir`.` with:

```markdown
Requires booth-agent with element-based layouts (booth-agent PR #42) and the bundled layouts copied into `compositing.templateDir`.
```

- [ ] **Step 7: Build**

Run: `npm run build --prefix kiosk`
Expected: `tsc --noEmit` passes with no errors, and `vite build` succeeds.

Run: `npm test`
Expected: the root suite, including `kiosk/src/layout.test.ts`, passes.

- [ ] **Step 8: Commit**

```bash
git add kiosk/src kiosk/README.md
git commit -m "feat(kiosk): layout editor with images, text, shapes, layers and undo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Browser check against the live agent (controller)

Not dispatched to a subagent: it needs the browser pane and the live agent. It uses a throwaway layout and makes no prints.

- [ ] **Step 1: Run the kiosk dev server from the branch.** `agent.allowedOrigins` includes `http://localhost:5173`. Copy the live env file into the repo (gitignored by `*.local`), then start:

```bash
cp /c/BoothAgent/kiosk/.env.local /c/Users/User/Documents/booth-agent/kiosk/.env.local
```

Add a `.claude/launch.json` configuration named `kiosk-dev` that runs `npm run dev --prefix C:/Users/User/Documents/booth-agent/kiosk -- --host localhost --port 5173`, and start it with `preview_start`.

- [ ] **Step 2: Exercise the editor.** Open the operator panel (5 taps on the status dot) → Settings → New layout, name it `zz-editor-check`, and check each of these:
  1. Add a photo, then text, then a shape. Each appears on top and is selected.
  2. Drag and resize a photo. Type a W with the lock on and confirm H follows. Rotate by +15.
  3. Align the shape "Bottom" and use "Fill paper" on it. Move it to the bottom layer with ↓.
  4. For the text:
     - Insert `{date}`; the canvas shows today's date.
     - Switch the font to Great Vibes; the canvas font changes.
     - Toggle bold and change the colour.
  5. Upload a PNG image. The layout gets saved first, and the image appears.
  6. Hide and show an element. Undo 3 times, then redo once.
  7. Change paper to 4R portrait; everything scales.
  8. Save. The Settings list shows the thumbnail with the correct photo count.

- [ ] **Step 3: Check the agent side.** `GET /templates` has `zz-editor-check` with every element type. Composite it once through `POST /composite`, using the four 2026-09-24 captures (`e2e116bb…`, `724b03c1…`, `3b23d8d9…`, `dc2bd04d…`). Look at the result and check:
  - the text rendered in the right font, as the service's LocalSystem account (the first text render under that account);
  - the rotation matches the editor.

- [ ] **Step 4: Clean up.**
  - Delete `zz-editor-check` from the editor (Delete layout → tap again).
  - Stop the dev server.
  - Remove `kiosk/.env.local` from the repo checkout.
  - Reset the viewport.

---

### Task 5: Ship the kiosk (controller, with the user's go-ahead per step)

- [ ] **Step 1:** Push `feat/kiosk-editor` and open the PR. The body should summarise Tasks 1-3 and the Task 4 results, and end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Wait for green CI; the kiosk build now runs in CI too.
- [ ] **Step 2:** After the merge:
  - `git checkout master && git pull`. Don't build the agent: nothing under `src/` changed.
  - Back up the live kiosk source: `Copy-Item -Recurse C:\BoothAgent\kiosk\src C:\BoothAgent\kiosk\src.bak-<yyyymmdd>`.
  - Deploy with the PowerShell commands in `kiosk/README.md` ("Deploying to the booth PC").
- [ ] **Step 3:** Ask the user to reload the kiosk (Ctrl+R, or Alt+F4 and reopen the shortcut). Then, in the browser pane at `http://127.0.0.1:4173`:
  - the attract screen appears;
  - the operator panel lists every layout;
  - `overlay-test` opens and shows its overlay as an image layer.

---

### Task 6: Remove the PR 1 compatibility layer (separate PR, after Task 5 is live)

Only after the new kiosk is deployed: the old kiosk depends on these fields.

**Files:**
- Modify: `src/compositor/template.ts`, `src/server/routes.ts`, `tests/template.test.ts`, `tests/templates.routes.test.ts`, `README.md`, `kiosk/src/layout.ts`

**Interfaces:**
- Removes: `withLegacyFields`, `ApiTemplate`, `LegacySlot`, `POST /templates/:id/overlay`, `GET /templates/:id/overlay`.
- Keeps: `migrateLegacyTemplate`. Old-format files on disk (for example `C:\BoothAgent\templates.bak-20260924`) must still load.

- [ ] **Step 1: Update the tests first**
  - In `tests/template.test.ts`:
    - Remove `withLegacyFields` from the import.
    - Delete the tests "round-trips through the legacy view the current kiosk reads" and "reports no overlay when the top element isn't a full-cell image".
    - Add this test to the "legacy templates" describe:

```ts
  it("still treats a body with photoSlots as old-format", () => {
    const t = validateTemplate({ ...legacy, elements: [{ id: "x", type: "rect", fill: "#000000", x: 0, y: 0, width: 1, height: 1 }] });
    expect(t.elements.map((e) => e.type)).toEqual(["photo", "photo", "image"]);
  });
```

  - In `tests/templates.routes.test.ts`:
    - Delete the "replaces the overlay through the compat route without touching the photos" test.
    - In "lists legacy layouts with both elements and the old fields", rename it to `"lists legacy layouts as elements"` and replace its assertions with:

```ts
    expect(templates[0].elements).toHaveLength(2);
    expect(templates[0]).not.toHaveProperty("photoSlots");
    expect(templates[0]).not.toHaveProperty("overlayFile");
```

    - In "uploads an asset and saves a layout that uses it", replace `expect((await save.json()).overlayFile).toBe(file);` with:

```ts
    expect((await save.json()).elements[1]).toMatchObject({ type: "image", file });
```

    - Add a test that the old overlay route is gone:

```ts
  it("no longer serves the old overlay routes", async () => {
    expect((await fetch(`${base}/templates/old/overlay`, { headers: auth })).status).toBe(404);
  });
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run tests/template.test.ts tests/templates.routes.test.ts`
Expected: FAIL. The list still has `photoSlots`, and the overlay route still answers.

- [ ] **Step 3: Remove the compatibility code**
  - In `src/compositor/template.ts`:
    - Delete `LegacySlot`, `ApiTemplate` and `withLegacyFields`.
    - In the doc comment of `migrateLegacyTemplate`, replace the sentences from "Anything carrying photoSlots counts as legacy" to the end with: "Anything carrying photoSlots counts as legacy, even alongside elements: that was the shape the pre-elements kiosk sent back."
  - In `src/server/routes.ts`:
    - Remove `withLegacyFields` from the import.
    - Replace every `withLegacyFields(x)` with `x` (`GET /templates` becomes `res.json({ templates: listTemplates(dir) })`).
    - Delete the `// Compat for the current kiosk editor` comment and both `/templates/:id/overlay` routes.
  - In `README.md`:
    - In the `GET /templates` API bullet, delete the sentence "Responses also carry the old `photoSlots`/`overlayFile` fields, derived, for the current kiosk."
    - Delete "`POST`/`GET /templates/:id/overlay` remain for the current kiosk editor."
  - In `kiosk/src/layout.ts`, replace the `templateBody` doc comment with:

```ts
/**
 * Just the fields booth-agent stores. A body carrying the pre-elements
 * photoSlots field would be treated as old-format, so never send extras.
 */
```

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm test && npm run build --prefix kiosk`
Expected: all pass. Don't run the agent's `npm run build` in this checkout until deploy.

- [ ] **Step 5: Commit, PR, deploy**

```bash
git add src/compositor/template.ts src/server/routes.ts tests/template.test.ts tests/templates.routes.test.ts README.md kiosk/src/layout.ts
git commit -m "refactor: drop the PR 1 compatibility fields and overlay routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Push on its own branch (`chore/drop-layout-compat`), open a PR, and wait for green CI. After the merge, deploy with `git pull && npm run build` and a service restart; never `npm ci` while the service runs. Then check `GET /templates` has no `photoSlots`, and that the kiosk editor still loads and saves a layout.
