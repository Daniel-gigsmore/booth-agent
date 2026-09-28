# Dual camera PR 2 (kiosk) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The kiosk lets an operator choose, in the layout editor, which camera (high or low) takes each photo. During a guest session it shows and uses that camera for each shot.

**Architecture:**
- Pure helpers in `kiosk/src/layout.ts` own the camera logic. They cover the camera of a shot, setting it for every box that shows that shot, alternating, keeping the cameras consistent when a box changes shot, and the guest prompt text. All of these are unit-tested.
- The editor panels and `GetReady` only wire those helpers to the UI.
- `agent.capture` and `agent.prefocus` send `{ camera }`, matching the booth-agent API merged in PR #55.

**Tech Stack:** React 18, TypeScript (strict), Vite, vitest (kiosk has its own `package.json` under `kiosk/`).

**Spec:** `docs/superpowers/specs/2026-09-27-dual-camera-design.md` (sections "Layouts and the editor" and "Kiosk guest flow (GetReady)").

## Global Constraints

- The camera slot names are exactly `"high"` and `"low"`. A photo element without `camera` means `"high"`.
- A layout that uses no low camera must look and behave exactly as today:
  - no arrows on the canvas or thumbnails;
  - the same guest prompt text: "Photo N of M · look up at the camera" / "Look up at the camera";
  - live view at the camera the capture uses (high).
- Every box that shows the same shot uses the same camera. booth-agent rejects anything else on save ("takes photo N with both cameras").
- Arrows: high = `↓` (it looks down at the guest), low = `↑`.
- Guest prompts:
  - for a layout using the low camera, high is "look up at the top camera" with an up-arrow icon, and low is "look down at the lower camera" with a down-arrow icon;
  - the shot numbering prefix stays "Photo N of M · ".
- The kiosk's request timeout (30 s in `call()`) already covers the agent's worst-case low capture (~25 s: low, then high, then webcam). No change.
- Run from `kiosk/`: `npx vitest run` and `npm run build` (which runs `tsc --noEmit`). Both must be clean before every commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Change |
|---|---|
| `kiosk/src/agent.ts` | `CameraSlot` type, `PhotoElement.camera?`, and `capture(camera)` / `prefocus(camera)` send `{ camera }` |
| `kiosk/src/layout.ts` | `cameraOf`, `cameraForShot`, `usesLowCamera`, `setShotCamera`, `alternateCameras`, `CAMERA_ARROW`, `shotPrompt`; `updateElement` keeps a moved box on its new shot's camera |
| `kiosk/src/layout.test.ts` | Tests for the above |
| `kiosk/src/EditorPanels.tsx` | The camera switch in the photo properties, and the "Alternate high/low" button in Add |
| `kiosk/src/LayoutEditor.tsx` | Wires the two callbacks; arrows on canvas photos and thumbnails |
| `kiosk/src/screens.tsx` | GetReady: per-shot live view URL, prompt and icon, and camera passed to capture/pre-focus |
| `kiosk/src/styles.css` | `.el-cam` (the small arrow on an editor photo box) |

---

### Task 1: Camera helpers in layout.ts, and the agent client

**Files:**
- Modify: `kiosk/src/agent.ts`, `kiosk/src/layout.ts`
- Test: `kiosk/src/layout.test.ts`

**Interfaces:**
- Produces, in `agent.ts`:
  - `export type CameraSlot = "high" | "low";`
  - `PhotoElement = Box & { type: "photo"; shot: number; camera?: CameraSlot }`
  - `agent.capture(camera?: CameraSlot)` and `agent.prefocus(camera?: CameraSlot)`
- Produces, in `layout.ts`:
  - `cameraOf(el: PhotoElement): CameraSlot`
  - `cameraForShot(t: Pick<Template, "elements">, shot: number): CameraSlot`
  - `usesLowCamera(t: Pick<Template, "elements">): boolean`
  - `setShotCamera(t: Template, shot: number, camera: CameraSlot): Template`
  - `alternateCameras(t: Template): Template`
  - `CAMERA_ARROW: Record<CameraSlot, string>`
  - `shotPrompt(t: Pick<Template, "elements">, shot: number): { text: string; camera: CameraSlot }`

- [ ] **Step 1: Write the failing tests.** In `kiosk/src/layout.test.ts`:
  - Add the new names to the `./layout` import: `alternateCameras, cameraForShot, setShotCamera, shotPrompt, usesLowCamera`.
  - Add a helper after `photo`:

```ts
const cam = (id: string, shot: number, camera: "high" | "low"): LayoutElement => ({ ...(photo(id, shot) as object), camera } as LayoutElement);
```

Then append:

```ts
describe("cameras", () => {
  it("a photo without a camera uses the high one", () => {
    const t = layout([photo("a", 0), cam("b", 1, "low")]);
    expect(cameraForShot(t, 0)).toBe("high");
    expect(cameraForShot(t, 1)).toBe("low");
    expect(usesLowCamera(t)).toBe(true);
    expect(usesLowCamera(layout([photo("a", 0)]))).toBe(false);
  });

  it("setting a shot's camera changes every box showing that shot, and nothing else", () => {
    const t = setShotCamera(layout([photo("a", 0), photo("b", 1), photo("c", 1), rect("r")]), 1, "low");
    expect(t.elements.map((e) => (e.type === "photo" ? e.camera ?? "high" : "-"))).toEqual(["high", "low", "low", "-"]);
  });

  it("alternates high, low, high, low by shot number", () => {
    const t = alternateCameras(layout([photo("a", 0), photo("b", 1), photo("c", 2), photo("d", 3), photo("e", 1)]));
    expect(t.elements.map((e) => (e.type === "photo" ? e.camera : "-"))).toEqual(["high", "low", "high", "low", "low"]);
  });

  it("a box moved onto another shot takes that shot's camera", () => {
    const t = updateElement(layout([cam("a", 0, "high"), cam("b", 1, "low"), cam("c", 2, "high")]), "c", { shot: 1 });
    expect(t.elements.find((e) => e.id === "c")).toMatchObject({ shot: 1, camera: "low" });
  });

  it("a box moved onto a new shot keeps its own camera", () => {
    const t = updateElement(layout([cam("a", 0, "low"), cam("b", 1, "high")]), "a", { shot: 2 });
    // compactShots renumbers the gap away: a becomes shot 1, b shot 0.
    expect(t.elements.find((e) => e.id === "a")).toMatchObject({ camera: "low" });
  });

  it("prompts like today for a layout without the low camera", () => {
    const t = layout([photo("a", 0), photo("b", 1)]);
    expect(shotPrompt(t, 0)).toEqual({ text: "Photo 1 of 2 · look up at the camera", camera: "high" });
    expect(shotPrompt(layout([photo("a", 0)]), 0)).toEqual({ text: "Look up at the camera", camera: "high" });
  });

  it("names the camera when the layout uses both", () => {
    const t = layout([cam("a", 0, "high"), cam("b", 1, "low")]);
    expect(shotPrompt(t, 0)).toEqual({ text: "Photo 1 of 2 · look up at the top camera", camera: "high" });
    expect(shotPrompt(t, 1)).toEqual({ text: "Photo 2 of 2 · look down at the lower camera", camera: "low" });
  });
});
```

Run: `cd kiosk && npx vitest run`. Expected: FAIL, because the helpers aren't exported.

- [ ] **Step 2: Update the agent client types and calls.** In `kiosk/src/agent.ts`:

```ts
/** Which of the booth's two Canons: mounted high looking down, or low looking up. */
export type CameraSlot = "high" | "low";
```

(place it above `interface Box`) and change:

```ts
export type PhotoElement = Box & { type: "photo"; shot: number; camera?: CameraSlot };
```

In `agent`:

```ts
  capture: (camera: CameraSlot = "high") => call<{ captureId: string }>("POST", "/capture", { camera }),
```

```ts
  /** Fire-and-forget: tells the camera a shot is ~1.5 s away. A failure never affects the countdown. */
  prefocus: (camera: CameraSlot = "high") => {
    void call("POST", "/camera/prefocus", { camera }).catch(() => undefined);
  },
```

- [ ] **Step 3: Implement the helpers.** In `kiosk/src/layout.ts`:
  - Change the import to `import type { CameraSlot, LayoutElement, PhotoElement, Template } from "./agent";`.
  - After `shotCount`, add:

```ts
/** The camera a photo box uses; a layout from before dual cameras means the high one. */
export const cameraOf = (el: PhotoElement): CameraSlot => el.camera ?? "high";

/** Which camera takes photo `shot` (every box showing it agrees; setShotCamera keeps it that way). */
export function cameraForShot(t: Pick<Template, "elements">, shot: number): CameraSlot {
  const el = t.elements.find((e): e is PhotoElement => e.type === "photo" && e.shot === shot);
  return el ? cameraOf(el) : "high";
}

export const usesLowCamera = (t: Pick<Template, "elements">) =>
  t.elements.some((e) => e.type === "photo" && cameraOf(e) === "low");

/** Sets the camera for every box that shows photo `shot` (booth-agent rejects a photo with two cameras). */
export function setShotCamera(t: Template, shot: number, camera: CameraSlot): Template {
  return { ...t, elements: t.elements.map((e) => (e.type === "photo" && e.shot === shot ? { ...e, camera } : e)) };
}

/** Photo 1 high, photo 2 low, photo 3 high, … */
export function alternateCameras(t: Template): Template {
  return {
    ...t,
    elements: t.elements.map((e) => (e.type === "photo" ? { ...e, camera: e.shot % 2 === 0 ? "high" : "low" } : e)),
  };
}

/** Shown beside the photo number: the high camera looks down, the low one looks up. */
export const CAMERA_ARROW: Record<CameraSlot, string> = { high: "↓", low: "↑" };

/** What GetReady tells the guest before photo `shot`, and which camera takes it. */
export function shotPrompt(t: Pick<Template, "elements">, shot: number): { text: string; camera: CameraSlot } {
  const total = shotCount(t);
  const camera = cameraForShot(t, shot);
  const where = !usesLowCamera(t) ? "the camera" : camera === "low" ? "the lower camera" : "the top camera";
  const look = camera === "low" && usesLowCamera(t) ? "look down at" : "look up at";
  const text = total > 1 ? `Photo ${shot + 1} of ${total} · ${look} ${where}` : `${look[0]!.toUpperCase()}${look.slice(1)} ${where}`;
  return { text, camera };
}
```

  - In `updateElement`, keep a box that moves onto an existing shot on that shot's camera. Replace the body with:

```ts
export function updateElement(t: Template, id: string, patch: Partial<LayoutElement>): Template {
  let next = patch;
  if ("shot" in patch && !("camera" in patch)) {
    // Joining a photo that other boxes already show: use their camera, or the save is rejected.
    const others = t.elements.filter((e): e is PhotoElement => e.type === "photo" && e.id !== id && e.shot === patch.shot);
    if (others[0]) next = { ...patch, camera: cameraOf(others[0]) } as Partial<LayoutElement>;
  }
  const elements = t.elements.map((e) => (e.id === id ? ({ ...e, ...next } as LayoutElement) : e));
  return { ...t, elements: "shot" in patch ? compactShots(elements) : elements };
}
```

- [ ] **Step 4: Run the tests and the build.** Run `cd kiosk && npx vitest run && npm run build`. Expected: PASS.
  - `screens.tsx` still calls `agent.capture()` and passes `agent.prefocus` as `onPrefocus`. The defaults keep that compiling.
  - If `onPrefocus={agent.prefocus}` now fails typecheck (the signature changed from `() => void` to `(camera?) => void`), leave it: Task 3 replaces it. An optional parameter is assignable to `() => void`, so it should compile.

- [ ] **Step 5: Commit.**

```bash
git add kiosk/src/agent.ts kiosk/src/layout.ts kiosk/src/layout.test.ts
git commit -m "feat(kiosk): camera per photo in layouts, and capture/prefocus send the camera"
```

---

### Task 2: Editor: camera switch, alternate button, arrows

**Files:**
- Modify: `kiosk/src/EditorPanels.tsx`, `kiosk/src/LayoutEditor.tsx`, `kiosk/src/styles.css`

**Interfaces:**
- Consumes, from Task 1: `cameraOf`, `setShotCamera`, `alternateCameras`, `usesLowCamera`, `CAMERA_ARROW`, and `CameraSlot`.
- Produces:
  - `PropsPanel` gains the prop `onCamera: (camera: CameraSlot) => void`;
  - `AddPanel` gains the prop `onAlternate: () => void`.

- [ ] **Step 1: Add the camera switch to the photo properties.** In `kiosk/src/EditorPanels.tsx`:
  - Import `CameraSlot` from `./agent`, and `cameraOf, CAMERA_ARROW` from `./layout`.
  - Add `onCamera` to `PropsPanel`'s props: `onCamera: (camera: CameraSlot) => void;` in the type, and `onCamera` in the destructuring.
  - Directly after the "Photo number" `field` block, inside the same `el.type === "photo"` branch (wrap both in a fragment `<>…</>`), add:

```tsx
          <div className="field">
            <span>Camera</span>
            <div className="row gap-8">
              {(["high", "low"] as const).map((c) => (
                <button key={c} type="button" className={`seg-btn ${cameraOf(el) === c ? "on" : ""}`} onClick={() => onCamera(c)}>
                  {c === "high" ? "High" : "Low"} {CAMERA_ARROW[c]}
                </button>
              ))}
            </div>
          </div>
```

- [ ] **Step 2: Add the alternate button.** In `AddPanel`:
  - Add the prop `onAlternate: () => void`.
  - After the "N photos per guest" line, add:

```tsx
      <button type="button" className="btn outline xs" disabled={busy || shots < 2} onClick={onAlternate}>
        Alternate high/low cameras
      </button>
```

- [ ] **Step 3: Wire them in `LayoutEditor.tsx`.**
  - Import `alternateCameras, CAMERA_ARROW, cameraOf, setShotCamera, usesLowCamera` from `./layout`.
  - On `<AddPanel …>`, add `onAlternate={() => change(alternateCameras(t))}`.
  - On `<PropsPanel …>`, add:

```tsx
            onCamera={(camera) => selected?.type === "photo" && change(setShotCamera(t, selected.shot, camera), `${selected.id}:camera`)}
```

- [ ] **Step 4: Show the arrows only when the layout uses the low camera.**
  - `ElementBody` gets a new prop `arrows: boolean`. Its photo case becomes:

```tsx
    case "photo":
      return (
        <div className="el-photo" style={{ fontSize: Math.min(el.width, el.height) * view / 2.5 }}>
          {el.shot + 1}
          {arrows && <span className="el-cam">{CAMERA_ARROW[cameraOf(el)]}</span>}
        </div>
      );
```

  - Where `<ElementBody …>` is rendered in the editor, pass `arrows={usesLowCamera(t)}`.
  - In `LayoutThumb`, the photo `<text>` content becomes `{e.shot + 1}{usesLowCamera(t) ? CAMERA_ARROW[cameraOf(e)] : ""}`.

- [ ] **Step 5: Style the arrow.** Append to `kiosk/src/styles.css`, next to `.el-photo`:

```css
.el-cam { font-size: 0.6em; margin-left: 0.15em; opacity: 0.85; }
```

- [ ] **Step 6: Build.** Run `cd kiosk && npx vitest run && npm run build`. Expected: PASS.

- [ ] **Step 7: Check it in the dev kiosk (by hand).** Open the operator panel → Settings → New layout, then:
  1. Select photo 2 and tap "Low ↑". Photo 2 now shows `2↑` and the others `1↓ 3↓ 4↓`.
  2. Tap Undo once. The arrows disappear, because no photo uses low any more.
  3. Tap "Alternate high/low cameras". The photos show `1↓ 2↑ 3↓ 4↑`.
  4. Set photo 4's "Photo number" to 2. It becomes `2↑`, taking photo 2's camera.
  5. Cancel. Don't save.

- [ ] **Step 8: Commit.**

```bash
git add kiosk/src/EditorPanels.tsx kiosk/src/LayoutEditor.tsx kiosk/src/styles.css
git commit -m "feat(kiosk): editor picks high/low camera per photo, with alternate button and arrows"
```

---

### Task 3: GetReady uses each shot's camera

**Files:**
- Modify: `kiosk/src/screens.tsx`

**Interfaces:**
- Consumes, from Task 1: `shotPrompt`, and `agent.capture(camera)` / `agent.prefocus(camera)`.

- [ ] **Step 1: Pass the camera to the capture retry.** Change `captureWithRetry`:

```ts
async function captureWithRetry(camera: CameraSlot, attempts = 3): Promise<{ captureId: string } | null> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await agent.capture(camera);
    } catch {
      if (i < attempts - 1) await sleep(1000);
    }
  }
  return null;
}
```

Import `CameraSlot` from `./agent` and `shotPrompt` from `./layout`.

- [ ] **Step 2: Wire GetReady.** In `GetReady`:
  - After `const shotNo = …`, add:

```ts
  // Before the last shot is saved shots.length can't exceed total - 1; clamp for the brief moment after.
  const prompt = shotPrompt(session.template, Math.min(shots.length, total - 1));
```

  - In `shoot()`: `const shot = captureWithRetry(prompt.camera);`.
  - The live view:

```tsx
      <img className="liveview" src={agentUrl(`/liveview?camera=${prompt.camera}`)} alt="" />
```
  - The prompt tag becomes:

```tsx
        <div className="tag big">
          {prompt.text.includes("look down")
            ? <Icon size={40} d="M12 5v14"><path d="M19 12l-7 7-7-7" /></Icon>
            : <Icon size={40} d="M12 19V5"><path d="M5 12l7-7 7 7" /></Icon>}
          {prompt.text}
        </div>
```

  - The Countdown: `onPrefocus={() => agent.prefocus(prompt.camera)}`.
  - `shotNo` is now unused. Remove it if TypeScript flags it (the kiosk tsconfig may not have `noUnusedLocals`; remove it anyway, since `prompt.text` carries the number).

- [ ] **Step 3: Build and test.** Run `cd kiosk && npx vitest run && npm run build`. Expected: PASS.

- [ ] **Step 4: Check that today's flow is unchanged (by hand, no photo).**
  - Open the dev kiosk with `#getready` in the URL. The debug hook in `App.tsx` starts GetReady with a 9999 s first countdown, so no shot is taken.
  - With the current session layout (no low camera), the prompt reads "Photo 1 of 4 · look up at the camera" with an up arrow.
  - The network panel shows `/liveview?camera=high`.
  - Close with ✕.

- [ ] **Step 5: Commit.**

```bash
git add kiosk/src/screens.tsx
git commit -m "feat(kiosk): GetReady shows, focuses and shoots with each photo's camera"
```

---

## After the last task

- Push the branch and open the PR.
- Deploying is a kiosk deploy only (see `kiosk/README.md`: robocopy `src`, copy the top-level files, then `npm install && npm run build` in `C:\BoothAgent\kiosk`). The agent (PR #55) is already live.
- Until the driver is `edsdk`, a layout that uses "low" still works: the agent serves low requests with the one camera. The prompt, though, will say "look down at the lower camera". So don't switch the live session layout to a dual-camera layout before the second camera is actually in use.
