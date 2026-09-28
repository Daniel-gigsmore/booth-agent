# Dual camera PR 3: operator panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator panel shows and drives both cameras. The Camera tab gets High and Low columns with Swap and Remember, and the Status tab gets one card per camera.

**Architecture:** This is a kiosk-only change: booth-agent (#55) already serves every route it needs. The two-camera view appears only when `/health` reports a low slot (`cameras.low !== null`), which happens only under the EDSDK driver. Under digiCamControl the panel looks and behaves exactly as today. Pure helpers live in a new `kiosk/src/cameras.ts` and are unit-tested. The UI is checked by hand.

**Tech Stack:** React 18 + TypeScript + Vite, vitest (kiosk under `kiosk/`).

**Spec:** `docs/superpowers/specs/2026-09-27-dual-camera-design.md` (sections "Operator panel", "API", "Health", and Phase 3).

## Global Constraints

- The camera slot names are exactly "high" and "low". Arrows: high = "↓", low = "↑" (reuse `CAMERA_ARROW` from `kiosk/src/layout.ts`).
- The two-camera UI appears only when `health.cameras.low` is not null. Otherwise the Camera tab and the Status tab look and behave exactly as today:
  - one camera;
  - the same controls and the same "CAMERA" card;
  - the same "Last camera issue" line.
- The agent API used is exactly:
  - `GET /cameras` → `{ slots: { high: { connected, model, serial, remembered }, low: {...} } }`;
  - `POST /cameras/swap`;
  - `POST /cameras/remember` (409 `{ error }` when there is no camera to pair);
  - `?camera=high|low` on `GET/POST /camera/settings`, `POST /camera/settings/reset` and `POST /camera/test-shot`;
  - `/liveview?camera=`.
- Swap and Remember restart both camera workers. The panel must recover without a page reload:
  - the pairing text reloads right after the call;
  - each camera column reloads its settings when its connection comes back.
- Kiosk-only deploy. No agent change.
- Commit messages end with a blank line and then EXACTLY `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Change |
|---|---|
| `kiosk/src/agent.ts` | `CameraDetail`, `CameraStatus`, `CameraSlotInfo`, `CameraPairing` types; `Health.cameras`; slot argument on the settings/test-shot calls; `cameras()`, `swapCameras()`, `rememberCameras()` |
| `kiosk/src/cameras.ts` (new) | Pure helpers: `SLOT_NAME`, `cameraNote` (moved from Operator.tsx), `slotNote`, `hasLowSlot`, `pairingText` |
| `kiosk/src/cameras.test.ts` (new) | Unit tests for the helpers |
| `kiosk/src/CameraTab.tsx` | Split into `CameraPanel` (one slot) and `CameraTab` (single view, or pairing bar + two columns) |
| `kiosk/src/Operator.tsx` | Imports `cameraNote`; the Status tab shows per-camera cards and issues when there is a low slot |
| `kiosk/src/styles.css` | `.camera-cols`, `.camera-settings-grid`, `.camera-off`, `.op-grid.five` |

---

### Task 1: Camera helpers and the agent client

**Files:**
- Create: `kiosk/src/cameras.ts`, `kiosk/src/cameras.test.ts`
- Modify: `kiosk/src/agent.ts`, `kiosk/src/Operator.tsx` (only the `cameraNote` move)

**Interfaces:**
- Produces, in `agent.ts`:
  - `export interface CameraDetail { battery: number | "ac" | null; mode: string | null; afMode: string | null; quality: { label: string; hasJpeg: boolean } | null; lastError: { message: string; at: string } | null }`
  - `export interface CameraStatus { connected: boolean; model: string | null; serial: string | null; detail: CameraDetail | null }`
  - `Health.cameras: { high: CameraStatus; low: CameraStatus | null }`
  - `export interface CameraSlotInfo { connected: boolean; model: string | null; serial: string | null; remembered: string | null }`
  - `export type CameraPairing = Record<CameraSlot, CameraSlotInfo>`
  - `agent.cameraSettings(slot?: CameraSlot)`, `agent.setCameraSettings(changes, slot?)`, `agent.resetCameraSettings(slot?)`, `agent.testShot(slot?)`: each slot defaults to `"high"`.
  - `agent.cameras(): Promise<CameraPairing>`, `agent.swapCameras()`, `agent.rememberCameras()`
- Produces, in `cameras.ts`: `SLOT_NAME`, `cameraNote(c: Health["camera"])`, `slotNote(s: CameraStatus)`, `hasLowSlot(h: Health | null)`, `pairingText(p: CameraPairing)`.

- [ ] **Step 1: Write the failing tests.** Create `kiosk/src/cameras.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CameraPairing, CameraStatus, Health } from "./agent";
import { cameraNote, hasLowSlot, pairingText, slotNote } from "./cameras";

const status = (over: Partial<CameraStatus> = {}): CameraStatus => ({
  connected: true, model: "Canon EOS R100", serial: "378032000939", detail: null, ...over,
});
const health = (low: CameraStatus | null) => ({ cameras: { high: status(), low } }) as unknown as Health;
const slot = (remembered: string | null) => ({ connected: true, model: "Canon EOS R100", serial: "1", remembered });

describe("cameraNote", () => {
  it("says there is no camera", () => {
    expect(cameraNote({ activeSource: "none", model: null })).toBe("No camera");
  });
  it("lists only the parts the agent knows", () => {
    expect(cameraNote({
      activeSource: "canon", model: "R100", battery: 80, mode: "M", afMode: "AI Servo",
      quality: { label: "RAW+JPEG", hasJpeg: true },
    })).toBe("Using canon · 80% · M · AI Servo · RAW+JPEG");
    expect(cameraNote({ activeSource: "canon", model: "R100", battery: "ac" })).toBe("Using canon · AC power");
  });
});

describe("slotNote", () => {
  it("says a slot with no camera is not connected", () => {
    expect(slotNote(status({ connected: false }))).toBe("Not connected");
  });
  it("says Connected when the camera has reported no detail yet", () => {
    expect(slotNote(status())).toBe("Connected");
  });
  it("lists battery, mode, AF and quality", () => {
    expect(slotNote(status({
      detail: { battery: 55, mode: "Av", afMode: "One Shot", quality: { label: "L", hasJpeg: true }, lastError: null },
    }))).toBe("55% · Av · One Shot · L");
  });
});

describe("hasLowSlot", () => {
  it("is false with no health, and under digiCamControl (low is null)", () => {
    expect(hasLowSlot(null)).toBe(false);
    expect(hasLowSlot(health(null))).toBe(false);
  });
  it("is true when the agent has a low slot, even with no camera in it", () => {
    expect(hasLowSlot(health(status({ connected: false })))).toBe(true);
  });
});

describe("pairingText", () => {
  it("says the pairing is remembered when either slot has a saved serial", () => {
    const p: CameraPairing = { high: slot("1"), low: slot(null) };
    expect(pairingText(p)).toMatch(/^Pairing remembered/);
  });
  it("says it is not remembered yet otherwise", () => {
    const p: CameraPairing = { high: slot(null), low: slot(null) };
    expect(pairingText(p)).toMatch(/^Pairing not remembered yet/);
  });
});
```

- [ ] **Step 2: Run them to see them fail.** Run `cd kiosk && npx vitest run src/cameras.test.ts`. Expected: FAIL, because `./cameras` does not exist.

- [ ] **Step 3: Add the types and calls to `kiosk/src/agent.ts`.**
  - Directly above `export interface Health`, add:

```ts
/** What one Canon reports about itself (booth-agent's CameraDetail). */
export interface CameraDetail {
  battery: number | "ac" | null;
  mode: string | null;
  afMode: string | null;
  quality: { label: string; hasJpeg: boolean } | null;
  lastError: { message: string; at: string } | null;
}

/** One camera slot in /health. */
export interface CameraStatus { connected: boolean; model: string | null; serial: string | null; detail: CameraDetail | null }
```

  - In `Health`, after the `camera: {…};` member, add:

```ts
  /** low is null when the agent has no low slot (digiCamControl). */
  cameras: { high: CameraStatus; low: CameraStatus | null };
```

  - `CameraSlot` is declared further down the file. Directly after its declaration, add:

```ts
/** One slot in GET /cameras. `remembered` is the serial saved for the slot, or null. */
export interface CameraSlotInfo { connected: boolean; model: string | null; serial: string | null; remembered: string | null }
export type CameraPairing = Record<CameraSlot, CameraSlotInfo>;
```

  - In `agent`, replace the four camera-settings/test-shot members (`cameraSettings` through `testShot`) with:

```ts
  cameraSettings: (slot: CameraSlot = "high") => call<CameraSettings>("GET", `/camera/settings?camera=${slot}`),
  setCameraSettings: (changes: Partial<Record<SettingKey, number>>, slot: CameraSlot = "high") =>
    call<CameraSettings>("POST", `/camera/settings?camera=${slot}`, changes),
  resetCameraSettings: (slot: CameraSlot = "high") =>
    call<{ saved: Record<string, never> }>("POST", `/camera/settings/reset?camera=${slot}`),
  testShot: async (slot: CameraSlot = "high") => {
    const res = await blobResponse(`/camera/test-shot?camera=${slot}`, {});
    return { blob: await res.blob(), source: res.headers.get("X-Capture-Source") ?? "unknown" };
  },
  cameras: () => call<{ slots: CameraPairing }>("GET", "/cameras").then((r) => r.slots),
  /** Both restart the camera workers; the cameras come back a few seconds later. */
  swapCameras: () => call("POST", "/cameras/swap"),
  rememberCameras: () => call("POST", "/cameras/remember"),
```

- [ ] **Step 4: Create `kiosk/src/cameras.ts`.**

```ts
// Pure helpers for showing the booth's cameras in the operator panel.
import type { CameraDetail, CameraPairing, CameraSlot, CameraStatus, Health } from "./agent";

export const SLOT_NAME: Record<CameraSlot, string> = { high: "High camera", low: "Low camera" };

function batteryText(b: CameraDetail["battery"] | undefined): string | null {
  return b === "ac" ? "AC power" : typeof b === "number" ? `${b}%` : null;
}

/** "Using canon · 80% · M · AI Servo · RAW+JPEG" - only the parts the agent knows. */
export function cameraNote(c: Health["camera"]): string {
  if (c.activeSource === "none") return "No camera";
  return [`Using ${c.activeSource}`, batteryText(c.battery), c.mode, c.afMode, c.quality?.label].filter(Boolean).join(" · ");
}

/** One slot: "80% · M · One Shot · L", "Connected" before the camera reports, or "Not connected". */
export function slotNote(s: CameraStatus): string {
  if (!s.connected) return "Not connected";
  const d = s.detail;
  return [batteryText(d?.battery), d?.mode, d?.afMode, d?.quality?.label].filter(Boolean).join(" · ") || "Connected";
}

/** Whether the agent has a low camera slot at all (only under the EDSDK driver). */
export const hasLowSlot = (h: Health | null): boolean => !!h?.cameras?.low;

export function pairingText(p: CameraPairing): string {
  return p.high.remembered || p.low.remembered
    ? "Pairing remembered: each camera reopens in its own slot."
    : "Pairing not remembered yet: which camera is High is arbitrary. Check the live views, Swap if needed, then Remember.";
}
```

- [ ] **Step 5: Move `cameraNote` out of `kiosk/src/Operator.tsx`.**
  - Delete its local `cameraNote` function and the doc comment above it.
  - Add `import { cameraNote } from "./cameras";`.
  - Nothing else changes in that file in this task.

- [ ] **Step 6: Run the tests and the build.** Run `cd kiosk && npx vitest run && npm run build`. Expected: every test passes (32 existing + 9 new = 41), and the build is clean.

- [ ] **Step 7: Commit.**

```bash
git add kiosk/src/agent.ts kiosk/src/cameras.ts kiosk/src/cameras.test.ts kiosk/src/Operator.tsx
git commit -F- <<'EOF'
feat(kiosk): camera pairing and per-slot camera calls in the agent client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Camera tab: High and Low columns, Swap and Remember

**Files:**
- Modify: `kiosk/src/CameraTab.tsx`, `kiosk/src/styles.css`

**Interfaces:**
- Consumes, from Task 1:
  - `agent.cameraSettings/setCameraSettings/resetCameraSettings/testShot` with a slot;
  - `agent.cameras/swapCameras/rememberCameras`;
  - `CameraPairing`, `CameraSlot` and `Health` from `./agent`;
  - `hasLowSlot`, `pairingText` and `SLOT_NAME` from `./cameras`.
- It also consumes `CAMERA_ARROW` from `./layout` and `useHealth` from `./hooks`.
- `Operator.tsx` keeps rendering `<CameraTab />` with no props.

- [ ] **Step 1: Rewrite `kiosk/src/CameraTab.tsx`.** Replace the whole file with the following. `CameraPanel` is today's tab body with a `slot` threaded through. Its single-camera markup (`compact` false, `offline` false) is today's markup unchanged, except that the live view URL now names the slot.

```tsx
import { useEffect, useState } from "react";
import { agent, agentUrl, CameraPairing, CameraSettings, CameraSlot, Health, SettingKey } from "./agent";
import { hasLowSlot, pairingText, SLOT_NAME } from "./cameras";
import { useHealth } from "./hooks";
import { CAMERA_ARROW } from "./layout";

const LABELS: Record<SettingKey, string> = {
  iso: "ISO", av: "Aperture", tv: "Shutter speed", wb: "White balance", ev: "Exposure compensation", quality: "Image quality",
};
const KEYS = Object.keys(LABELS) as SettingKey[];

/**
 * One camera's controls: only values the camera accepts right now, a test shot, and saved settings.
 * `compact` stacks it into one column for the two-camera view. `offline` hides the live view, because
 * the agent would otherwise stream the other camera (live view follows the capture's fallback).
 */
function CameraPanel({ slot, compact, offline }: { slot: CameraSlot; compact: boolean; offline: boolean }) {
  const [s, setS] = useState<CameraSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [shotSource, setShotSource] = useState<string | null>(null);

  const load = () => agent.cameraSettings(slot).then((r) => { setS(r); setError(""); }, (e: Error) => setError(e.message));
  // Reload when the camera comes back (after a Swap/Remember restart or a replug).
  useEffect(() => { void load(); }, [slot, offline]);
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot); }, [shot]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const change = (key: SettingKey, code: number) =>
    run(async () => {
      const r = await agent.setCameraSettings({ [key]: code }, slot);
      setS(r);
      setError(r.rejected.length ? `The camera refused: ${r.rejected.map((k) => LABELS[k]).join(", ")}` : "");
    });

  return (
    <div className={compact ? "col gap-24" : "row gap-40 camera-tab"}>
      <div className="col gap-20">
        {offline
          ? <div className="camera-live camera-off">Not connected</div>
          : <img className="camera-live" src={agentUrl(`/liveview?camera=${slot}`)} alt="Live view" />}
        {shot && <img className="camera-live" src={shot} alt="Test shot" />}
        {shot && shotSource !== "canon" && (
          <div className="banner warn fs-24">
            This test shot came from the webcam (the Canon did not take it) - it does not show the Canon's settings.
          </div>
        )}
        <div className="row gap-20">
          <button type="button" className="btn primary sm" disabled={busy}
            onClick={() => run(async () => {
              const { blob, source } = await agent.testShot(slot);
              setShot(URL.createObjectURL(blob));
              setShotSource(source);
              setError("");
            })}>Test shot</button>
          <button type="button" className="btn outline sm" disabled={busy}
            onClick={() => run(async () => { await agent.resetCameraSettings(slot); await load(); })}>Use camera's current settings</button>
        </div>
      </div>
      <div className={compact ? "camera-settings-grid" : "col gap-24 grow"}>
        {error && <div className="banner error fs-24">{error}</div>}
        {s && <div className="muted fs-24">Mode dial: {s.mode ?? "unknown"}</div>}
        {s && KEYS.map((key) => {
          const f = s.settings[key];
          const current = f.value;
          return (
            <label key={key} className="col gap-6">
              <span className="op-label">{LABELS[key]}</span>
              <select className="text-input" disabled={busy || f.options.length === 0}
                value={current?.code ?? ""} onChange={(e) => void change(key, Number(e.target.value))}>
                {!current && <option value="">–</option>}
                {current && !f.options.some((o) => o.code === current.code) && <option value={current.code}>{current.label}</option>}
                {f.options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
              </select>
              {f.options.length === 0 && <span className="muted fs-20">Set by the camera in this mode</span>}
              {s.saved[key] !== undefined && <span className="muted fs-20">Saved - re-applied when the camera reconnects</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** One camera as today; with a low slot (EDSDK), High and Low side by side plus the pairing controls. */
export default function CameraTab() {
  const polled = useHealth(5_000);
  // Keep the last answer, so one missed poll doesn't tear down the two-camera view.
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => { if (polled) setHealth(polled); }, [polled]);
  const [pairing, setPairing] = useState<CameraPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadPairing = () => agent.cameras().then(setPairing, (e: Error) => setError(e.message));
  useEffect(() => { void loadPairing(); }, []);

  if (!hasLowSlot(health)) return <CameraPanel slot="high" compact={false} offline={false} />;

  const pair = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
      setError("");
      await loadPairing();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col gap-24">
      <div className="row gap-20">
        <div className="fs-24 grow">{pairing ? pairingText(pairing) : "…"}</div>
        <button type="button" className="btn outline sm" disabled={busy} onClick={pair(agent.swapCameras)}>Swap</button>
        <button type="button" className="btn primary sm" disabled={busy} onClick={pair(agent.rememberCameras)}>Remember</button>
      </div>
      {error && <div className="banner error fs-24">{error}</div>}
      <div className="camera-cols">
        {(["high", "low"] as const).map((slot) => {
          const c = health?.cameras[slot];
          return (
            <div key={slot} className="col gap-20">
              <div className="display fs-36">{SLOT_NAME[slot]} {CAMERA_ARROW[slot]}</div>
              <div className="muted fs-24">
                {c?.connected ? `${c.model ?? "Canon"} · serial ${c.serial ?? "unknown"}` : "Not connected"}
              </div>
              <CameraPanel slot={slot} compact offline={!c?.connected} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Style it.** Append to `kiosk/src/styles.css`, directly after the `.camera-live` rule:

```css
.camera-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 40px; }
.camera-cols .camera-live { width: 100%; }
.camera-off { display: flex; align-items: center; justify-content: center; color: #fff; font-size: 28px; font-weight: 700; }
.camera-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 24px; }
.camera-settings-grid > .banner, .camera-settings-grid > .muted { grid-column: 1 / -1; }
```

- [ ] **Step 3: Build.** Run `cd kiosk && npx vitest run && npm run build`. Expected: PASS.

- [ ] **Step 4: Check by hand (controller).**
  - Under today's digiCamControl agent (`cameras.low` is null), the dev kiosk's Camera tab looks as before: one live view, Test shot, the settings on the right, and no pairing bar.
  - The live view `<img>` src is `/liveview?camera=high`.
  - The two-column view can't be reached without the EDSDK driver. To check it, stub `/health` in the dev browser (JavaScript fetch override, dev only):
    1. With `cameras.low = { connected: false, … }`, there are two columns, "High camera ↓" and "Low camera ↑". Low shows the "Not connected" box.
    2. The pairing bar reads "Pairing not remembered yet…".
    3. Tapping Remember shows the agent's 409 text, "No camera to pair - connect the cameras first", in the error banner.
  - Tap nothing that changes camera settings. The agent's "Test shot" would try the real camera; skip it.

- [ ] **Step 5: Commit.**

```bash
git add kiosk/src/CameraTab.tsx kiosk/src/styles.css
git commit -F- <<'EOF'
feat(kiosk): Camera tab shows High and Low side by side, with Swap and Remember

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Status tab: one card and issue line per camera

**Files:**
- Modify: `kiosk/src/Operator.tsx` (the `StatusTab` function), `kiosk/src/styles.css`

**Interfaces:**
- Consumes, from Task 1:
  - `slotNote` and `SLOT_NAME` from `./cameras`;
  - `Health.cameras` with `CameraStatus`.
- It also consumes `CAMERA_ARROW` from `./layout`.

- [ ] **Step 1: Per-camera cards.** In `StatusTab` in `kiosk/src/Operator.tsx`:
  - Extend the imports: `import { cameraNote, slotNote, SLOT_NAME } from "./cameras";` and add `CAMERA_ARROW` to the existing `./layout` import.
  - After `const h = health;`, add:

```ts
  // Both slots only when the agent has a low one (EDSDK); otherwise today's single CAMERA card.
  const slots = h?.cameras?.low ? { high: h.cameras.high, low: h.cameras.low } : null;
```

  - Change `<div className="op-grid">` to `<div className={`op-grid${slots ? " five" : ""}`}>`.
  - Replace the single `<Card label="CAMERA" … />` with:

```tsx
            {slots ? (["high", "low"] as const).map((slot) => (
              <Card key={slot} label={`${SLOT_NAME[slot].toUpperCase()} ${CAMERA_ARROW[slot]}`}
                value={slots[slot].connected ? slots[slot].model ?? "Canon" : "Not connected"}
                ok={slots[slot].connected} note={slotNote(slots[slot])} />
            )) : (
              <Card label="CAMERA" value={h.camera.model ?? h.camera.activeSource}
                ok={h.camera.activeSource !== "none"} note={cameraNote(h.camera)} />
            )}
```

  - Replace the `{h.camera.lastError && (…)}` block with:

```tsx
          {slots ? (["high", "low"] as const).map((slot) => {
            const e = slots[slot].detail?.lastError;
            return e && (
              <div key={slot} className="muted fs-24">
                Last {SLOT_NAME[slot].toLowerCase()} issue ({time(e.at)}): {e.message}
              </div>
            );
          }) : h.camera.lastError && (
            <div className="muted fs-24">
              Last camera issue ({time(h.camera.lastError.at)}): {h.camera.lastError.message}
            </div>
          )}
```

- [ ] **Step 2: Five columns when there are two cameras.** Append to `kiosk/src/styles.css`, directly after the `.op-grid` rule:

```css
.op-grid.five { grid-template-columns: repeat(5, minmax(0, 1fr)); }
```

- [ ] **Step 3: Build.** Run `cd kiosk && npx vitest run && npm run build`. Expected: PASS.

- [ ] **Step 4: Check by hand (controller).**
  - Under today's agent, the Status tab shows the same four cards as before, with "CAMERA" first.
  - With `/health` stubbed so that `cameras.low = { connected: false, … }` and `cameras.high.detail.lastError` is set, it shows five cards:
    - "HIGH CAMERA ↓";
    - "LOW CAMERA ↑", with "Not connected";
    - printer, photo sync and hot folder.
  - It also shows a "Last high camera issue (…)" line.

- [ ] **Step 5: Commit.**

```bash
git add kiosk/src/Operator.tsx kiosk/src/styles.css
git commit -F- <<'EOF'
feat(kiosk): Status tab shows a card and last issue per camera

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## After the last task

- Push the branch and open the PR.
- The deploy is kiosk only (`kiosk/README.md`). Nothing changes on the booth until the driver is `edsdk`.
- Still deferred on the agent side (from PR 1, not in this PR):
  - low-slot camera-disconnected/recovered events;
  - `slotParam` answers high for a bad value instead of 400;
  - `restart()` hard-kills the worker.
