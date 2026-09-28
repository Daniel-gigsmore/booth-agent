# Dual camera PR 1 (agent) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** booth-agent can drive a second ("low") Canon alongside the existing ("high") one. Each capture, live view, pre-focus and settings call can name the camera, and layouts can say which camera takes each photo.

**Architecture:**
- There is one EDSDK camera-worker process per camera. Each is told the body serial it owns (and the one to leave alone) through argv, and it finds that body by opening each connected camera and reading `kEdsPropID_BodyIDEx`.
- `CameraManager` gains an optional `canonLow` source. A `low` request uses it when it's up; otherwise the request goes through today's high/webcam path.
- Pairings live in `<dataDir>/cameras.json`, and settings in `<dataDir>/camera-<slot>.json`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Node 24, Express, zod, koffi, vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-dual-camera-design.md`

## Global Constraints

- The camera slot names are exactly `"high"` and `"low"`. A request with no camera means `"high"`.
- Nothing may change for a single-camera booth or the digiCamControl driver:
  - old layouts, old kiosks and requests with no camera behave exactly as today;
  - the existing `/health` `camera` object keeps its shape.
- The worker argv is `[dllPath, serial, avoid]`, with `""` meaning none.
- All new routes are GET or POST behind the existing bearer auth.
- `tsc` only checks `src/`. Tests run through vitest; keep test fixtures working at runtime.
- Run `npm run typecheck` and `npx vitest run` from the worktree root before every commit. Both must be clean.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Change |
|---|---|
| `src/events/types.ts` | + `CameraSlot`, `CaptureCamera` |
| `src/camera/edsdk/edsdkApi.ts` | `firstCamera()` becomes `cameras()`; + `getString()`, `PROP_BODY_ID_EX` |
| `src/camera/edsdk/edsdkNative.ts` | Implements `cameras()` and `getString()` |
| `src/camera/edsdk/protocol.ts` | The `state` event gains `serial` |
| `src/camera/edsdk/CameraWorker.ts` | Serial-matching scan; `CameraTarget` constructor arg |
| `src/camera/edsdk/worker.ts` | Reads serial/avoid from argv |
| `tests/helpers/fakeEdsdk.ts` | Multiple bodies with serials, and "held" bodies |
| `src/camera/edsdk/EdsdkSource.ts` | `spawnWorker(dll, target)`, `getSerial()`, `restart()` |
| `src/camera/CameraSource.ts` | + optional `getSerial()`, `restart()` |
| `src/camera/camerasStore.ts` (new) | `cameras.json` read/write and `workerTarget()` |
| `src/camera/cameraSettingsStore.ts` | Per-slot files and the legacy rename |
| `src/compositor/template.ts` | Photo `camera` field, validation, `cameraForShot()`, `usesCamera()` |
| `src/camera/CameraManager.ts` | Low slot, routing, `captureExact()`, `restartCanonWorkers()`, status |
| `src/outbox/db.ts`, `types.ts`, `outboxStore.ts` | `camera` column |
| `src/server/routes.ts` | Camera param on the capture/liveview/prefocus/settings/test-shot routes; `/cameras`, swap, remember |
| `src/health/healthReport.ts` | `cameras` block and low-slot alerts |
| `src/index.ts` | Wires two EDSDK sources |
| `README.md` | A dual camera section |

---

### Task 1: EDSDK serials and the serial-matching worker scan

**Files:**
- Modify: `src/events/types.ts`, `src/camera/edsdk/edsdkApi.ts`, `src/camera/edsdk/edsdkNative.ts`, `src/camera/edsdk/protocol.ts`, `src/camera/edsdk/CameraWorker.ts`, `src/camera/edsdk/worker.ts`, `tests/helpers/fakeEdsdk.ts`
- Test: `tests/edsdk.worker.test.ts`

**Interfaces:**
- Produces:
  - `type CameraSlot = "high" | "low"` and `type CaptureCamera = CameraSlot | "webcam"` (in `src/events/types.ts`).
  - `EdsApi.cameras(): Array<{ ref: EdsRef; description: string }>`.
  - `EdsApi.getString(cam, prop): { err: number; value: string }`.
  - `EDS.PROP_BODY_ID_EX = 0x15`.
  - `interface CameraTarget { serial: string | null; avoid: string | null }`, exported from `CameraWorker.ts`.
  - `new CameraWorker(eds, emit, clock?, target?)`.
  - The worker `state` event is `{ type: "state"; connected; model; serial: string | null }`.

- [ ] **Step 1: Add the slot types.** Append to `src/events/types.ts`:

```ts
/** Which of the booth's two Canons: mounted high looking down, or low looking up. */
export type CameraSlot = "high" | "low";
/** What actually took a photo: one of the Canon slots, or the webcam fallback. */
export type CaptureCamera = CameraSlot | "webcam";
```

- [ ] **Step 2: Update the EdsApi interface.** In `src/camera/edsdk/edsdkApi.ts`:
  - Add `PROP_BODY_ID_EX: 0x15,` after `PROP_BATTERY_LEVEL`.
  - Replace the `firstCamera()` declaration with:

```ts
  /** Every connected camera, in EDSDK's order. The caller owns every returned ref and must release each one. */
  cameras(): Array<{ ref: EdsRef; description: string }>;
```

  - After `getU32`, add:

```ts
  /** A string property (e.g. the body serial). Only readable with a session open. */
  getString(cam: EdsRef, prop: number): { err: number; value: string };
```

- [ ] **Step 3: Implement them natively.** In `src/camera/edsdk/edsdkNative.ts`, add to `f` after `getPropertyDesc`:

```ts
    getPropertySize: lib.func("uint32 __stdcall EdsGetPropertySize(void *ref, uint32 id, int32 param, _Out_ int32 *type, _Out_ uint32 *size)"),
    // Same export as getU32, typed for a caller-owned byte buffer (string properties).
    getBytes: lib.func("uint32 __stdcall EdsGetPropertyData(void *ref, uint32 id, int32 param, uint32 size, void *data)"),
```

Replace the `firstCamera()` implementation with:

```ts
    cameras() {
      const list: unknown[] = [null];
      if (f.getCameraList(list) !== 0) return [];
      try {
        const count = [0];
        if (f.getChildCount(list[0], count) !== 0) return [];
        const found: Array<{ ref: EdsRef; description: string }> = [];
        for (let i = 0; i < (count[0] ?? 0); i += 1) {
          const cam: unknown[] = [null];
          if (f.getChildAtIndex(list[0], i, cam) !== 0) continue;
          const info: { szDeviceDescription?: string } = {};
          f.getDeviceInfo(cam[0], info);
          found.push({ ref: cam[0], description: info.szDeviceDescription || "Canon camera" });
        }
        return found;
      } finally {
        f.release(list[0]);
      }
    },
```

After `getU32`, add:

```ts
    getString(cam, prop) {
      const type = [0];
      const size = [0];
      let err = f.getPropertySize(cam, prop, 0, type, size);
      if (err !== 0) return { err, value: "" };
      const buf = Buffer.alloc(Math.max(1, size[0] ?? 0));
      err = f.getBytes(cam, prop, 0, buf.length, buf);
      if (err !== 0) return { err, value: "" };
      const end = buf.indexOf(0);
      return { err: 0, value: buf.toString("latin1", 0, end === -1 ? buf.length : end).trim() };
    },
```

- [ ] **Step 4: Add serial to the state event.** In `src/camera/edsdk/protocol.ts`, change the `state` member of `WorkerEvent` to:

```ts
  | { type: "state"; connected: boolean; model: string | null; serial: string | null }
```

- [ ] **Step 5: Make the fake EDSDK support several bodies.** In `tests/helpers/fakeEdsdk.ts`:
  - Replace the `camera` field with the code below.
  - Replace `firstCamera()` with `cameras()`.
  - Update `openSession`/`closeSession`/`release`.
  - Add `getString`.

```ts
  /** Connected bodies in EDSDK's order. A ref is the body's serial. `held` = another process has its session. */
  bodies: Array<{ name: string; serial: string; held?: boolean }> = [{ name: "Canon EOS R100", serial: "SN-A" }];
  /** Shorthand for "exactly this one body plugged in" (null = none), used by the single-camera tests. */
  get camera(): string | null { return this.bodies[0]?.name ?? null; }
  set camera(name: string | null) { this.bodies = name ? [{ name, serial: "SN-A" }] : []; }
  /** Every ref passed to release(), in order. */
  released: EdsRef[] = [];
```

```ts
  cameras(): Array<{ ref: EdsRef; description: string }> {
    this.calls.push("cameras");
    return this.bodies.map((b) => ({ ref: b.serial, description: b.name }));
  }
  openSession(cam: EdsRef): number {
    this.calls.push("openSession");
    const body = this.bodies.find((b) => b.serial === cam);
    if (!body || body.held) return EDS.ERR_COMM_PORT_IS_IN_USE;
    this.sessionOpen = true;
    return 0;
  }
  closeSession(): number { this.sessionOpen = false; this.calls.push("closeSession"); return 0; }
  release(ref: EdsRef): void { this.released.push(ref); }
```

```ts
  getString(cam: EdsRef, prop: number): { err: number; value: string } {
    return prop === EDS.PROP_BODY_ID_EX ? { err: 0, value: String(cam) } : { err: 0x50, value: "" };
  }
```

`unplug()` still sets `this.camera = null`, which now empties `bodies`.

- [ ] **Step 6: Update the existing worker tests for the renamed call and the new state field.** In `tests/edsdk.worker.test.ts`:
  - Change `c === "firstCamera"` to `c === "cameras"`.
  - Every expected `{ type: "state", connected: true, model: "Canon EOS R100" }` becomes `{ type: "state", connected: true, model: "Canon EOS R100", serial: "SN-A" }`.
  - Every expected `{ type: "state", connected: false, model: null }` becomes `{ type: "state", connected: false, model: null, serial: null }`.

Run `npx vitest run tests/edsdk.worker.test.ts`. Expected: FAIL, because CameraWorker still calls `firstCamera`.

- [ ] **Step 7: Write the failing serial tests.** Append to `tests/edsdk.worker.test.ts`:

```ts
describe("CameraWorker with two cameras", () => {
  const twoBodies = () => [
    { name: "Canon EOS R100", serial: "SN-A" },
    { name: "Canon EOS R100", serial: "SN-B" },
  ];
  const make = (target: { serial: string | null; avoid: string | null }) => {
    eds = new FakeEds();
    eds.bodies = twoBodies();
    clock = fakeClock(1_000_000);
    events = [];
    worker = new CameraWorker(eds, (e) => events.push(e), clock, target);
    worker.start();
  };

  it("keeps only the body with its serial, closing and releasing the other", () => {
    make({ serial: "SN-B", avoid: null });
    worker.tick();
    expect(states().at(-1)).toEqual({ type: "state", connected: true, model: "Canon EOS R100", serial: "SN-B" });
    expect(eds.calls.filter((c) => c === "closeSession")).toHaveLength(1); // SN-A opened, read, closed
    expect(eds.released).toContain("SN-A");
    expect(eds.released).not.toContain("SN-B");
  });

  it("skips a body another worker holds", () => {
    make({ serial: null, avoid: null });
    eds.bodies[0]!.held = true;
    worker.tick();
    expect(states().at(-1)).toMatchObject({ connected: true, serial: "SN-B" });
    expect(eds.released).toContain("SN-A");
  });

  it("with no serial, takes the first free body but never the avoided one", () => {
    make({ serial: null, avoid: "SN-A" });
    worker.tick();
    expect(states().at(-1)).toMatchObject({ connected: true, serial: "SN-B" });
  });

  it("stays unconnected when its serial isn't plugged in, and says so once", () => {
    make({ serial: "SN-C", avoid: null });
    worker.tick();
    expect(worker.connected).toBe(false);
    expect(states()).toEqual([{ type: "state", connected: false, model: null, serial: null }]);
    expect(eds.released).toEqual(["SN-A", "SN-B"]);
  });
});
```

Run: `npx vitest run tests/edsdk.worker.test.ts`. Expected: FAIL.

- [ ] **Step 8: Implement the scan in `CameraWorker`.**
  - Add the export below the `Clock` definitions.
  - Add a `serial` field next to `cam`.
  - Add the constructor parameter.

```ts
/** Which camera body a worker owns: `serial` (null = the first free body), never `avoid` (the other slot's body). */
export interface CameraTarget {
  serial: string | null;
  avoid: string | null;
}
```

```ts
  /** The connected body's serial (kEdsPropID_BodyIDEx), or null. */
  private serial: string | null = null;
```

```ts
  constructor(
    private readonly eds: EdsApi,
    private readonly emit: (event: WorkerEvent) => void,
    private readonly clock: Clock = realClock,
    private readonly target: CameraTarget = { serial: null, avoid: null }
  ) {}
```

In `tick()`, the first-scan announcement becomes:

```ts
        if (!this.announced && !this.cam) this.emit({ type: "state", connected: false, model: null, serial: null });
```

Replace the start of `scan()`, from `const found = this.eds.firstCamera();` through `this.shutdownSeen = false;`, with:

```ts
    const found = this.eds.cameras();
    if (found.length === 0) {
      this.emptyScans += 1;
      if (this.emptyScans >= REINIT_AFTER_EMPTY_SCANS) {
        this.emptyScans = 0;
        this.eds.terminate();
        this.eds.initialize();
      }
      return;
    }
    this.emptyScans = 0;
    let picked: { ref: EdsRef; description: string; serial: string } | null = null;
    for (const { ref, description } of found) {
      const serial = picked ? null : this.claim(ref, description);
      if (serial === null) {
        this.eds.release(ref);
        continue;
      }
      picked = { ref, description, serial };
    }
    if (!picked) return;
    const cam = picked.ref;
    this.cam = cam;
    this.serial = picked.serial;
    this.shutdownSeen = false;
```

In the rest of `scan()`:
- `found.description` becomes `picked.description`.
- The connected emit becomes:

```ts
    this.emit({ type: "state", connected: true, model: picked.description, serial: this.serial });
```

Add the `claim()` method after `scan()`:

```ts
  /**
   * Opens `ref` and returns its serial if this worker should own it, else null
   * (session closed again; the caller releases the ref). A body another
   * worker holds fails to open and is simply skipped.
   */
  private claim(ref: EdsRef, description: string): string | null {
    const err = this.eds.openSession(ref);
    if (err !== EDS.ERR_OK) {
      this.warn(`Opening a session with ${description} failed: ${hex(err)}`);
      return null;
    }
    const id = this.eds.getString(ref, EDS.PROP_BODY_ID_EX);
    const serial = id.err === EDS.ERR_OK ? id.value : "";
    const mine = this.target.serial ? serial === this.target.serial : !(this.target.avoid && serial === this.target.avoid);
    if (!mine) {
      this.eds.closeSession(ref);
      return null;
    }
    return serial;
  }
```

In `disconnect()`, change the emit to `{ type: "state", connected: false, model: null, serial: null }` and add `this.serial = null;` after `this.cam = null;`.

- [ ] **Step 9: Pass the target through argv.** In `src/camera/edsdk/worker.ts`:

```ts
import { CameraWorker, realClock } from "./CameraWorker";
```

```ts
const [dllPath, serial, avoid] = process.argv.slice(2);
```

```ts
const worker = new CameraWorker(loadEdsdk(dllPath), send, realClock, { serial: serial || null, avoid: avoid || null });
```

- [ ] **Step 10: Run the tests and typecheck.**

Run: `npm run typecheck && npx vitest run tests/edsdk.worker.test.ts`. Expected: PASS. `EdsdkSource.ts` still compiles because it only reads `message.connected` and `message.model`.

- [ ] **Step 11: Commit.**

```bash
git add src/events/types.ts src/camera/edsdk tests/helpers/fakeEdsdk.ts tests/edsdk.worker.test.ts
git commit -m "feat(edsdk): worker finds its camera by body serial, skipping bodies held elsewhere"
```

---

### Task 2: EdsdkSource knows its serial and can restart its worker

**Files:**
- Modify: `src/camera/CameraSource.ts`, `src/camera/edsdk/EdsdkSource.ts`
- Test: `tests/edsdk.source.test.ts`

**Interfaces:**
- Consumes: the `CameraTarget` type from Task 1.
- Produces:
  - `spawnWorker(dllPath: string, target: CameraTarget): WorkerHandle`.
  - `EdsdkSource.getSerial(): string | null`.
  - `EdsdkSource.restart(): void`.
  - Optional `CameraSource.getSerial?()` and `CameraSource.restart?()`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/edsdk.source.test.ts`:

```ts
describe("EdsdkSource serial and restart", () => {
  it("reports the serial from the worker's state", () => {
    current().push({ type: "state", connected: true, model: "Canon EOS R100", serial: "SN-B" });
    expect(source.getSerial()).toBe("SN-B");
    current().push({ type: "state", connected: false, model: null, serial: null });
    expect(source.getSerial()).toBeNull();
  });

  it("restart() kills the worker and spawns a fresh one after 1 s, without recording an error", async () => {
    const first = current();
    source.restart();
    expect(first.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(workers).toHaveLength(2);
    expect(source.getDetail()?.lastError ?? null).toBeNull();
  });
});
```

Run: `npx vitest run tests/edsdk.source.test.ts`. Expected: FAIL (`getSerial` is not a function).

- [ ] **Step 2: Add the optional members to `CameraSource`.** Append inside the interface in `src/camera/CameraSource.ts`:

```ts
  /** Optional: the connected body's serial number, for pairing cameras to slots. */
  getSerial?(): string | null;
  /** Optional: drop and re-open the camera (e.g. after its slot's serial changed). */
  restart?(): void;
```

- [ ] **Step 3: Implement it in `EdsdkSource`.**

Change `spawnWorker`:

```ts
import type { CameraTarget } from "./CameraWorker";
```

```ts
/** Forks the compiled worker with argv [dllPath, serial, avoid] ("" = none). */
export function spawnWorker(dllPath: string, target: CameraTarget): WorkerHandle {
  const child = fork(path.join(__dirname, "worker.js"), [dllPath, target.serial ?? "", target.avoid ?? ""], {
```

Add fields:

```ts
  private serial: string | null = null;
  /** Set by restart(): the coming exit is ours, not a crash. */
  private restarting = false;
```

Add methods after `getDetail()`:

```ts
  getSerial(): string | null {
    return this.serial;
  }

  /** Kills the worker; onExit respawns it, and the spawn function reads the slot's current serial. */
  restart(): void {
    if (!this.worker) return;
    this.restarting = true;
    this.worker.kill();
  }
```

In `onMessage`'s state branch, add `this.serial = message.serial;` after `this.model = message.model;`.

In `onExit`, replace the `if (!this.stopping) { this.detail = ... }` block and the delay computation with:

```ts
    const planned = this.restarting;
    this.restarting = false;
    this.serial = null;
    if (!this.stopping && !planned) {
      this.detail = {
        battery: null, mode: null, afMode: null, quality: null,
        lastError: { message: `Camera worker exited (code ${String(code)})`, at: new Date().toISOString() },
      };
    }
```

Leave the pending-rejection loop and `if (this.stopping) return;` as they are. Then:

```ts
    const delay = planned ? RESPAWN_BACKOFF_MS[0] : RESPAWN_BACKOFF_MS[Math.min(this.respawns, RESPAWN_BACKOFF_MS.length - 1)]!;
    if (!planned) this.respawns += 1;
```

Keep the existing `log.warn` and `setTimeout`. For a planned restart, log `info` instead: `log[planned ? "info" : "warn"](...)`.

- [ ] **Step 4: Update the FakeWorker first state** in `tests/edsdk.source.test.ts`. The `emit("message", { type: "state", connected: firstState, model: ... })` gains `serial: firstState ? "SN-A" : null`.

- [ ] **Step 5: Run the tests.** Run `npm run typecheck && npx vitest run tests/edsdk.source.test.ts`. Expected: PASS. `src/index.ts` will fail typecheck on `spawnWorker(canonConfig.edsdkDllPath)`. Temporarily change that call to `spawnWorker(canonConfig.edsdkDllPath, { serial: null, avoid: null })`; Task 7 replaces it.

- [ ] **Step 6: Commit.**

```bash
git add src/camera/CameraSource.ts src/camera/edsdk/EdsdkSource.ts src/index.ts tests/edsdk.source.test.ts
git commit -m "feat(edsdk): source reports its body serial and can restart its worker"
```

---

### Task 3: cameras.json and per-slot settings files

**Files:**
- Create: `src/camera/camerasStore.ts`
- Modify: `src/camera/cameraSettingsStore.ts`
- Test: `tests/camera.stores.test.ts` (new), `tests/camera.settings.test.ts` (update the store calls)

**Interfaces:**
- Consumes: `CameraSlot` (Task 1) and `CameraTarget` (Task 1).
- Produces:
  - `type CameraSerials = Partial<Record<CameraSlot, string>>`
  - `readCameraSerials(dataDir): CameraSerials`
  - `writeCameraSerials(dataDir, serials: CameraSerials): void`
  - `workerTarget(serials, slot): CameraTarget`
  - `readSavedCameraSettings(dataDir, slot)`
  - `saveCameraSettings(dataDir, slot, changes)`
  - `clearSavedCameraSettings(dataDir, slot)`
  - `migrateLegacyCameraSettings(dataDir): void`

- [ ] **Step 1: Write the failing tests.** Create `tests/camera.stores.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCameraSerials, writeCameraSerials, workerTarget } from "../src/camera/camerasStore";
import {
  readSavedCameraSettings, saveCameraSettings, clearSavedCameraSettings, migrateLegacyCameraSettings,
} from "../src/camera/cameraSettingsStore";

const dir = () => mkdtempSync(path.join(tmpdir(), "camstore-"));

describe("cameras.json", () => {
  it("round-trips serials and treats missing or corrupt files as nothing saved", () => {
    const d = dir();
    expect(readCameraSerials(d)).toEqual({});
    writeCameraSerials(d, { high: "SN-A", low: "SN-B" });
    expect(readCameraSerials(d)).toEqual({ high: "SN-A", low: "SN-B" });
    writeFileSync(path.join(d, "cameras.json"), "{nope");
    expect(readCameraSerials(d)).toEqual({});
  });

  it("tells each slot's worker its body and the other slot's body to avoid", () => {
    expect(workerTarget({ high: "SN-A", low: "SN-B" }, "low")).toEqual({ serial: "SN-B", avoid: "SN-A" });
    expect(workerTarget({ high: "SN-A" }, "low")).toEqual({ serial: null, avoid: "SN-A" });
    expect(workerTarget({}, "high")).toEqual({ serial: null, avoid: null });
  });
});

describe("per-camera settings", () => {
  it("keeps each slot's settings in its own file", () => {
    const d = dir();
    saveCameraSettings(d, "high", { iso: 0x48 });
    saveCameraSettings(d, "low", { iso: 0x60 });
    expect(readSavedCameraSettings(d, "high")).toEqual({ iso: 0x48 });
    expect(readSavedCameraSettings(d, "low")).toEqual({ iso: 0x60 });
    clearSavedCameraSettings(d, "low");
    expect(readSavedCameraSettings(d, "low")).toEqual({});
    expect(readSavedCameraSettings(d, "high")).toEqual({ iso: 0x48 });
  });

  it("moves an old camera.json to camera-high.json once, never over an existing one", () => {
    const d = dir();
    writeFileSync(path.join(d, "camera.json"), JSON.stringify({ iso: 0x48 }));
    migrateLegacyCameraSettings(d);
    expect(existsSync(path.join(d, "camera.json"))).toBe(false);
    expect(readSavedCameraSettings(d, "high")).toEqual({ iso: 0x48 });

    writeFileSync(path.join(d, "camera.json"), JSON.stringify({ iso: 0x60 }));
    migrateLegacyCameraSettings(d);
    expect(JSON.parse(readFileSync(path.join(d, "camera-high.json"), "utf-8"))).toEqual({ iso: 0x48 });
  });
});
```

Run: `npx vitest run tests/camera.stores.test.ts`. Expected: FAIL (cannot find module `camerasStore`).

- [ ] **Step 2: Create `src/camera/camerasStore.ts`.**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CameraSlot } from "../events/types";
import type { CameraTarget } from "./edsdk/CameraWorker";

/**
 * Which camera body (by serial) is the high one and which the low one, as the
 * operator confirmed it in the Camera tab. Without it the two workers each take
 * whichever free body they open first, so the pairing is arbitrary.
 */
export type CameraSerials = Partial<Record<CameraSlot, string>>;

const Schema = z.object({ high: z.string().min(1), low: z.string().min(1) }).partial().strict();
const file = (dataDir: string) => path.join(dataDir, "cameras.json");

export function readCameraSerials(dataDir: string): CameraSerials {
  if (!existsSync(file(dataDir))) return {};
  try {
    return Schema.parse(JSON.parse(readFileSync(file(dataDir), "utf-8"))) as CameraSerials;
  } catch {
    return {};
  }
}

export function writeCameraSerials(dataDir: string, serials: CameraSerials): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file(dataDir), JSON.stringify(serials, null, 2) + "\n");
}

/** What a slot's worker is told: the body it owns (null = first free one) and the other slot's body. */
export function workerTarget(serials: CameraSerials, slot: CameraSlot): CameraTarget {
  const other: CameraSlot = slot === "high" ? "low" : "high";
  return { serial: serials[slot] ?? null, avoid: serials[other] ?? null };
}
```

- [ ] **Step 3: Make the settings store per slot.** In `src/camera/cameraSettingsStore.ts`:
  - Add `renameSync` to the `node:fs` import.
  - Add `import { CameraSlot } from "../events/types";`.
  - Replace `file` and the three functions with:

```ts
const file = (dataDir: string, slot: CameraSlot) => path.join(dataDir, `camera-${slot}.json`);

export function readSavedCameraSettings(dataDir: string, slot: CameraSlot): SettingChanges {
  if (!existsSync(file(dataDir, slot))) return {};
  try {
    // zod's `.partial()` types each key as `number | undefined`; exactOptionalPropertyTypes
    // treats that as stricter than "key may be absent", which is all SettingChanges means.
    return SettingChangesSchema.parse(JSON.parse(readFileSync(file(dataDir, slot), "utf-8"))) as SettingChanges;
  } catch {
    return {};
  }
}

/** Merges `changes` into what's saved for this camera and returns the result. */
export function saveCameraSettings(dataDir: string, slot: CameraSlot, changes: SettingChanges): SettingChanges {
  const merged = { ...readSavedCameraSettings(dataDir, slot), ...changes };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file(dataDir, slot), JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

export function clearSavedCameraSettings(dataDir: string, slot: CameraSlot): void {
  rmSync(file(dataDir, slot), { force: true });
}

/** Before two cameras there was one camera.json; it belongs to the high camera. */
export function migrateLegacyCameraSettings(dataDir: string): void {
  const legacy = path.join(dataDir, "camera.json");
  if (existsSync(legacy) && !existsSync(file(dataDir, "high"))) renameSync(legacy, file(dataDir, "high"));
}
```

Update the doc comment at the top to say "kept per camera as camera-high.json / camera-low.json".

- [ ] **Step 4: Update the existing store tests.** In `tests/camera.settings.test.ts`:
  - The store tests pass `"high"` as the second argument everywhere.
  - The corrupt-file test writes `camera-high.json`.
  - The route tests' `saveCameraSettings(dataDir, {...})` and `readSavedCameraSettings(dataDir)` calls, and `clearSavedCameraSettings(dataDir)` in `beforeEach`, pass `"high"`. The routes themselves are changed in Task 6; until then those route tests fail on typecheck only (tests aren't typechecked), and at runtime once `routes.ts` is compiled against the new signature.

- [ ] **Step 5: Fix the callers so the source compiles.**
  - `src/server/routes.ts`: every `readSavedCameraSettings(dir)`, `saveCameraSettings(dir, x)` and `clearSavedCameraSettings(dir)` gains `"high"` as the slot argument (Task 6 makes it per request).
  - `src/index.ts`: `readSavedCameraSettings(config.storage.dataDir, "high")`.

- [ ] **Step 6: Run the tests.** Run `npm run typecheck && npx vitest run tests/camera.stores.test.ts tests/camera.settings.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/camera/camerasStore.ts src/camera/cameraSettingsStore.ts src/server/routes.ts src/index.ts tests/camera.stores.test.ts tests/camera.settings.test.ts
git commit -m "feat(camera): cameras.json pairing store and per-camera settings files"
```

---

### Task 4: Layouts say which camera takes each photo

**Files:**
- Modify: `src/compositor/template.ts`
- Test: `tests/template.test.ts`

**Interfaces:**
- Consumes: `CameraSlot` (Task 1).
- Produces:
  - Photo element `camera: CameraSlot`, defaulting to `"high"`.
  - `cameraForShot(t: EventTemplate, shot: number): CameraSlot`
  - `usesCamera(t: EventTemplate, slot: CameraSlot): boolean`

- [ ] **Step 1: Write the failing tests.** Append to `tests/template.test.ts`. Reuse that file's existing helper for a minimal valid template if there is one; the block below builds its own.

```ts
import { validateTemplate, cameraForShot, usesCamera } from "../src/compositor/template";

describe("photo cameras", () => {
  const layout = (photos: Array<{ shot: number; camera?: "high" | "low" }>) => ({
    id: "dual-test",
    name: "Dual",
    printSize: "4x6",
    cellWidthPx: 1800,
    cellHeightPx: 1200,
    background: "#ffffff",
    elements: photos.map((p, i) => ({ id: `p${i}`, type: "photo", x: 0, y: 0, width: 100, height: 100, ...p })),
  });

  it("defaults a photo to the high camera", () => {
    const t = validateTemplate(layout([{ shot: 0 }]));
    expect(cameraForShot(t, 0)).toBe("high");
    expect(usesCamera(t, "low")).toBe(false);
  });

  it("reads the camera per shot", () => {
    const t = validateTemplate(layout([{ shot: 0 }, { shot: 1, camera: "low" }, { shot: 1, camera: "low" }]));
    expect(cameraForShot(t, 1)).toBe("low");
    expect(usesCamera(t, "low")).toBe(true);
  });

  it("rejects one photo shown with two different cameras", () => {
    expect(() => validateTemplate(layout([{ shot: 0, camera: "high" }, { shot: 0, camera: "low" }]))).toThrow(/both cameras/);
  });
});
```

If `tests/template.test.ts` already imports from `template`, merge the import instead of duplicating it. Check that `1800x1200` with `printSize: "4x6"` is an allowed cell size (see `allowedCellSizes`); if not, use the size an existing test in that file uses.

Run: `npx vitest run tests/template.test.ts`. Expected: FAIL (`cameraForShot` is not exported).

- [ ] **Step 2: Implement it.** In `src/compositor/template.ts`:
  - Add `import { CameraSlot } from "../events/types";`.
  - Change the photo element schema to:

```ts
  /** shot is 0-based: which of the guest's photos goes here; camera is which Canon takes it. */
  z.object({
    ...box,
    type: z.literal("photo"),
    shot: z.number().int().min(0).max(11),
    camera: z.enum(["high", "low"]).default("high"),
  }),
```

After `shotCount`, add:

```ts
/** Which camera takes photo `shot` (every box showing it agrees; validateTemplate checks). */
export function cameraForShot(t: EventTemplate, shot: number): CameraSlot {
  const el = t.elements.find((e) => e.type === "photo" && e.shot === shot);
  return el?.type === "photo" ? el.camera : "high";
}

export function usesCamera(t: EventTemplate, slot: CameraSlot): boolean {
  return t.elements.some((e) => e.type === "photo" && e.camera === slot);
}
```

In `validateTemplate`, after the shots-skip check, add:

```ts
  const cameraOf = new Map<number, CameraSlot>();
  for (const el of parsed.elements) {
    if (el.type !== "photo") continue;
    const seen = cameraOf.get(el.shot);
    if (seen && seen !== el.camera) {
      throw new Error(
        `Template "${parsed.id}" takes photo ${el.shot + 1} with both cameras - every box showing one photo must use the same camera`
      );
    }
    cameraOf.set(el.shot, el.camera);
  }
```

- [ ] **Step 3: Run the whole suite** (the new default touches compositor and template-transfer fixtures). Run `npm run typecheck && npx vitest run`.
  - Expected: PASS.
  - If a test compares a whole parsed template with `toEqual`, add `camera: "high"` to its expected photo elements.

- [ ] **Step 4: Commit.**

```bash
git add src/compositor/template.ts tests/template.test.ts
git commit -m "feat(layouts): photo elements name the camera that takes them (high by default)"
```

---

### Task 5: CameraManager routes requests to the high or low camera

**Files:**
- Modify: `src/camera/CameraManager.ts`
- Test: `tests/camera.dual.test.ts` (new)

**Interfaces:**
- Consumes:
  - `CameraSlot` and `CaptureCamera` (Task 1).
  - `CameraSource.getSerial?` and `restart?` (Task 2).
- Produces:
  - `new CameraManager({ canon, webcam, canonLow? }, preference, eventBus, pollMs?)`
  - `capture(destDir, camera?: CameraSlot): Promise<CaptureResult & { source: CameraKind; camera: CaptureCamera }>`
  - `captureExact(destDir, camera: CameraSlot)`, which returns the same shape and throws `CameraUnavailableError`
  - `prefocus(camera?)` and `getLiveviewFrame(camera?)`
  - `getCanonSettings(camera?)` and `setCanonSettings(changes, camera?)`
  - `restartCanonWorkers(): void`
  - `CameraManagerStatus` gains the fields below:

```ts
  canonModel: string | null;
  canonSerial: string | null;
  /** Null when there is no low camera slot (digiCamControl driver). */
  low: { connected: boolean; model: string | null; serial: string | null; detail: CameraDetail | null } | null;
```

- [ ] **Step 1: Write the failing tests.** Create `tests/camera.dual.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { CameraManager } from "../src/camera/CameraManager";
import { CameraSource, CameraUnavailableError, CaptureResult } from "../src/camera/CameraSource";
import { EventBus } from "../src/events/eventBus";

class Fake implements CameraSource {
  healthy = true;
  failCapture = false;
  restarted = 0;
  prefocused = 0;
  constructor(readonly kind: "canon" | "webcam", readonly name: string, private readonly serial: string | null = null) {}
  async initialize() { return this.healthy; }
  async shutdown() {}
  async isHealthy() { return this.healthy; }
  async capture(): Promise<CaptureResult> {
    if (this.failCapture) throw new Error(`${this.name} failed`);
    return { filePath: `/tmp/${this.name}.jpg`, width: 1, height: 1 };
  }
  async getLiveviewFrame() { return this.healthy ? Buffer.from(this.name) : null; }
  async prefocus() { this.prefocused += 1; }
  getModel() { return this.name; }
  getSerial() { return this.serial; }
  restart() { this.restarted += 1; }
  async getSettings() { return { mode: this.name, settings: {} as never, rejected: [] }; }
  async setSettings() { return { mode: this.name, settings: {} as never, rejected: [] }; }
}

const waitUntil = async (p: () => boolean) => {
  const start = Date.now();
  while (!p()) {
    if (Date.now() - start > 2000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let manager: CameraManager | undefined;
afterEach(async () => { await manager?.stop(); manager = undefined; });

async function setup(opts: { withLow?: boolean } = {}) {
  const high = new Fake("canon", "high", "SN-A");
  const low = new Fake("canon", "low", "SN-B");
  const webcam = new Fake("webcam", "webcam");
  manager = new CameraManager(
    { canon: high, webcam, ...(opts.withLow === false ? {} : { canonLow: low }) },
    "canon", new EventBus(), 20
  );
  await manager.start();
  return { high, low, webcam, manager };
}

describe("CameraManager with a low camera", () => {
  it("captures on the camera asked for, high by default", async () => {
    const { manager } = await setup();
    expect(await manager.capture("/tmp")).toMatchObject({ camera: "high", source: "canon", filePath: "/tmp/high.jpg" });
    expect(await manager.capture("/tmp", "low")).toMatchObject({ camera: "low", source: "canon", filePath: "/tmp/low.jpg" });
  });

  it("falls back low -> high -> webcam", async () => {
    const { manager, low, high } = await setup();
    low.failCapture = true;
    expect(await manager.capture("/tmp", "low")).toMatchObject({ camera: "high" });
    low.failCapture = false;
    // low is now marked down until the poll sees it healthy twice
    high.failCapture = true;
    expect(await manager.capture("/tmp", "low")).toMatchObject({ camera: "webcam", source: "webcam" });
  });

  it("serves a low request from the high camera when there is no low slot (digiCamControl)", async () => {
    const { manager } = await setup({ withLow: false });
    expect(await manager.capture("/tmp", "low")).toMatchObject({ camera: "high" });
    expect(manager.getStatus().low).toBeNull();
  });

  it("routes live view and pre-focus like the capture", async () => {
    const { manager, low, high } = await setup();
    expect((await manager.getLiveviewFrame("low"))?.frame.toString()).toBe("low");
    await manager.prefocus("low");
    expect(low.prefocused).toBe(1);
    low.healthy = false;
    await waitUntil(() => manager.getStatus().low?.connected === false);
    expect((await manager.getLiveviewFrame("low"))?.frame.toString()).toBe("high");
    await manager.prefocus("low");
    expect(high.prefocused).toBe(1);
  });

  it("captureExact never falls back", async () => {
    const { manager, low } = await setup();
    low.healthy = false;
    await waitUntil(() => manager.getStatus().low?.connected === false);
    await expect(manager.captureExact("/tmp", "low")).rejects.toBeInstanceOf(CameraUnavailableError);
    const noLow = await setup({ withLow: false });
    await expect(noLow.manager.captureExact("/tmp", "low")).rejects.toThrow(/EDSDK/);
  });

  it("settings go to the named camera", async () => {
    const { manager } = await setup();
    expect((await manager.getCanonSettings("low")).mode).toBe("low");
    expect((await manager.setCanonSettings({}, "high")).mode).toBe("high");
  });

  it("reports both cameras and restarts both workers", async () => {
    const { manager, high, low } = await setup();
    expect(manager.getStatus()).toMatchObject({
      canonModel: "high", canonSerial: "SN-A",
      low: { connected: true, model: "low", serial: "SN-B", detail: null },
    });
    manager.restartCanonWorkers();
    expect([high.restarted, low.restarted]).toEqual([1, 1]);
  });
});
```

Note that `captureExact`'s second case calls `setup()` again, which reassigns `manager`. Stop the first manager before that (`await manager.stop()`), or keep a separate variable and stop both in the test.

Run: `npx vitest run tests/camera.dual.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement it in `CameraManager`.**
  - Import `CameraSlot, CaptureCamera` from `../events/types`.
  - Extend `CameraManagerStatus` as listed under Interfaces.
  - Add the fields:

```ts
  /** The second Canon (EDSDK only). Not part of the high/webcam active-source logic. */
  private readonly low: CameraSource | null;
  private lowHealthy = false;
  private lowConsecutive = 0;
```

Change the constructor signature to accept `sources: { canon: CameraSource; webcam: CameraSource; canonLow?: CameraSource }`. Store `this.sources = { canon: sources.canon, webcam: sources.webcam }` and `this.low = sources.canonLow ?? null`.

`start()` initialises the low camera in the same `Promise.all`:

```ts
    const [canonOk, webcamOk, lowOk] = await Promise.all([
      this.sources.canon.initialize().catch(() => false),
      this.sources.webcam.initialize().catch(() => false),
      this.low ? this.low.initialize().catch(() => false) : Promise.resolve(false),
    ]);
    this.lowHealthy = lowOk;
```

`stop()` also awaits `this.low?.shutdown()`.

Rename the existing `capture` body to a private `captureHigh(destDir): Promise<CaptureResult & { source: CameraKind }>`, unchanged, and add:

```ts
  /**
   * A photo on `camera`, falling back low -> high -> webcam so a guest always
   * gets a picture. `camera` in the result says what actually took it.
   */
  async capture(destDir: string, camera: CameraSlot = "high"): Promise<CaptureResult & { source: CameraKind; camera: CaptureCamera }> {
    if (camera === "low" && this.low && this.lowHealthy) {
      try {
        return { ...(await this.low.capture(destDir)), source: "canon", camera: "low" };
      } catch (err) {
        log.warn("Capture failed on the low camera, marking it unhealthy and using the high one", err);
        this.lowHealthy = false;
        this.lowConsecutive = 0;
      }
    } else if (camera === "low") {
      log.warn("The low camera isn't available - taking this photo with the high one");
    }
    const result = await this.captureHigh(destDir);
    return { ...result, camera: result.source === "canon" ? "high" : "webcam" };
  }

  /** The operator's test shot: exactly this camera, or CameraUnavailableError. */
  async captureExact(destDir: string, camera: CameraSlot): Promise<CaptureResult & { source: CameraKind; camera: CaptureCamera }> {
    const source = this.canonSlot(camera);
    const up = camera === "low" ? this.lowHealthy : this.healthy.canon;
    if (!up) throw new CameraUnavailableError(`The ${camera} camera is not connected`);
    return { ...(await source.capture(destDir)), source: "canon", camera };
  }

  /** The source a live view or pre-focus for `camera` should use: whatever its capture would. */
  private routed(camera: CameraSlot): { source: CameraSource; kind: CameraKind } | null {
    if (camera === "low" && this.low && this.lowHealthy) return { source: this.low, kind: "canon" };
    if (this.active === "none") return null;
    return { source: this.sources[this.active], kind: this.active };
  }

  private canonSlot(camera: CameraSlot): CameraSource {
    if (camera === "high") return this.sources.canon;
    if (!this.low) throw new CameraUnavailableError("A low camera needs the EDSDK driver");
    return this.low;
  }

  /** After cameras.json changed: both workers re-open with their slot's serial. */
  restartCanonWorkers(): void {
    this.sources.canon.restart?.();
    this.low?.restart?.();
  }
```

Rewrite `prefocus` and `getLiveviewFrame` on top of `routed`:

```ts
  async prefocus(camera: CameraSlot = "high"): Promise<void> {
    const r = this.routed(camera);
    if (!r) return;
    try {
      await r.source.prefocus?.();
    } catch (err) {
      log.debug(`Pre-focus failed on ${camera}`, err);
    }
  }

  async getLiveviewFrame(camera: CameraSlot = "high"): Promise<{ frame: Buffer; source: CameraKind } | null> {
    const r = this.routed(camera);
    if (!r) return null;
    const frame = await r.source.getLiveviewFrame();
    return frame ? { frame, source: r.kind } : null;
  }
```

Settings:

```ts
  async getCanonSettings(camera: CameraSlot = "high"): Promise<CameraSettings> {
    const source = this.canonSlot(camera);
    if (!source.getSettings) throw new CameraUnavailableError("Camera settings need the EDSDK driver");
    return source.getSettings();
  }

  async setCanonSettings(changes: SettingChanges, camera: CameraSlot = "high"): Promise<CameraSettings> {
    const source = this.canonSlot(camera);
    if (!source.setSettings) throw new CameraUnavailableError("Camera settings need the EDSDK driver");
    return source.setSettings(changes);
  }
```

`getStatus()` adds:

```ts
      canonModel: this.sources.canon.getModel(),
      canonSerial: this.sources.canon.getSerial?.() ?? null,
      low: this.low
        ? { connected: this.lowHealthy, model: this.low.getModel(), serial: this.low.getSerial?.() ?? null, detail: this.low.getDetail?.() ?? null }
        : null,
```

In `pollOnce()`, after the existing `Promise.all`, poll the low camera with the same debounce:

```ts
    if (this.low) {
      const isHealthy = await this.low.isHealthy().catch(() => false);
      if (isHealthy === this.lowHealthy) {
        this.lowConsecutive = 0;
      } else if (++this.lowConsecutive >= SWITCH_DEBOUNCE_TICKS) {
        this.lowHealthy = isHealthy;
        this.lowConsecutive = 0;
        log[isHealthy ? "info" : "warn"](`Low camera ${isHealthy ? "connected" : "disconnected"}`);
      }
    }
```

- [ ] **Step 3: Run the tests.** Run `npm run typecheck && npx vitest run tests/camera.dual.test.ts tests/camera.fallback.test.ts tests/camera.prefocus.test.ts`. Expected: PASS.
  - `camera.fallback.test.ts` asserts `result.source`, which is unchanged.
  - `routes.ts` still calls `capture(dir)`, which is fine because the camera parameter has a default.

- [ ] **Step 4: Commit.**

```bash
git add src/camera/CameraManager.ts tests/camera.dual.test.ts
git commit -m "feat(camera): manager routes high/low requests, falling back low -> high -> webcam"
```

---

### Task 6: API and outbox

**Files:**
- Modify: `src/outbox/db.ts`, `src/outbox/types.ts`, `src/outbox/outboxStore.ts`, `src/server/routes.ts`
- Test: `tests/camera.routes.dual.test.ts` (new), `tests/outbox.migration.test.ts`

**Interfaces:**
- Consumes:
  - Task 3: `readCameraSerials`, `writeCameraSerials`, and the per-slot settings store.
  - Task 5: the manager API.
- Produces:
  - `NewCapture.camera?: string` and `CaptureRow.camera: string | null`.
  - The route contracts listed in the spec's API table.

- [ ] **Step 1: Write the failing outbox test.** Append to `tests/outbox.migration.test.ts`. Match that file's imports (`createInMemoryOutboxDb`, `OutboxStore`).

```ts
it("stores which camera took a capture (null for old rows)", () => {
  const store = new OutboxStore(createInMemoryOutboxDb());
  store.insertCapture({ id: "a", eventId: "e", source: "canon", camera: "low", originalPath: "a.jpg", takenAt: new Date().toISOString() });
  store.insertCapture({ id: "b", eventId: "e", source: "canon", originalPath: "b.jpg", takenAt: new Date().toISOString() });
  expect(store.getById("a")?.camera).toBe("low");
  expect(store.getById("b")?.camera).toBeNull();
});
```

- [ ] **Step 2: Implement the outbox column.**
  - `src/outbox/db.ts`: after the other `ensureColumn` calls, add:

```ts
  // Which Canon took the photo ("high"/"low"), or "webcam". Local bookkeeping only; not uploaded.
  ensureColumn(db, "captures", "camera", "TEXT");
```

  - `src/outbox/types.ts`: add `camera?: string;` to `NewCapture` and `camera: string | null;` to `CaptureRow`.
  - `src/outbox/outboxStore.ts` `insertCapture`:

```ts
        `INSERT INTO captures (id, event_id, source, camera, original_path, taken_at, sync_status, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(capture.id, capture.eventId, capture.source, capture.camera ?? null, capture.originalPath, capture.takenAt, capture.takenAt);
```

Run `npx vitest run tests/outbox.migration.test.ts`. Expected: PASS.

- [ ] **Step 3: Write the failing route tests.** Create `tests/camera.routes.dual.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import sharp from "sharp";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";
import { CameraUnavailableError } from "../src/camera/CameraSource";
import { readCameraSerials, writeCameraSerials } from "../src/camera/camerasStore";
import { readSavedCameraSettings } from "../src/camera/cameraSettingsStore";

const SECRET = "test-secret";
const dataDir = mkdtempSync(path.join(tmpdir(), "dualroutes-"));
const jpeg = async (dir: string) => {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `shot-${Math.random()}.jpg`);
  await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } }).jpeg().toFile(filePath);
  return filePath;
};
const status = {
  canonConnected: true, canonModel: "Canon EOS R100", canonSerial: "SN-A",
  low: { connected: true, model: "Canon EOS R100", serial: "SN-B", detail: null } as { connected: boolean; model: string | null; serial: string | null; detail: null } | null,
};
const manager = {
  capture: vi.fn(async (dir: string, camera = "high") => ({ filePath: await jpeg(dir), width: 4, height: 4, source: "canon", camera })),
  captureExact: vi.fn(async (dir: string, camera: string) => ({ filePath: await jpeg(dir), width: 4, height: 4, source: "canon", camera })),
  prefocus: vi.fn(async () => {}),
  getCanonSettings: vi.fn(async (camera = "high") => ({ mode: camera, settings: {}, rejected: [] })),
  setCanonSettings: vi.fn(async (_c: object, camera = "high") => ({ mode: camera, settings: {}, rejected: [] })),
  restartCanonWorkers: vi.fn(),
  getStatus: vi.fn(() => status),
};
const outboxStore = { insertCapture: vi.fn() };
let server: Server;
let base: string;
const req = (p: string, method = "GET", body?: object) =>
  fetch(`${base}${p}`, {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(() => {
  const ctx = {
    configStore: { current: { agent: { allowedOrigins: [], sharedSecret: SECRET }, storage: { dataDir }, event: { id: "evt" } } },
    cameraManager: manager,
    outboxStore,
    eventBus: { emit: vi.fn() },
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { vi.clearAllMocks(); writeCameraSerials(dataDir, {}); });

describe("dual camera routes", () => {
  it("/capture takes the camera from the body, high by default, and records it", async () => {
    let res = await req("/capture", "POST");
    expect(res.status).toBe(201);
    expect((await res.json()).camera).toBe("high");
    res = await req("/capture", "POST", { camera: "low" });
    expect((await res.json()).camera).toBe("low");
    expect(manager.capture).toHaveBeenLastCalledWith(expect.any(String), "low");
    expect(outboxStore.insertCapture).toHaveBeenLastCalledWith(expect.objectContaining({ camera: "low" }));
    expect((await req("/capture", "POST", { camera: "side" })).status).toBe(400);
  });

  it("/camera/prefocus passes the camera", async () => {
    await req("/camera/prefocus", "POST", { camera: "low" });
    expect(manager.prefocus).toHaveBeenCalledWith("low");
  });

  it("settings are per camera, saved per camera", async () => {
    const res = await req("/camera/settings?camera=low", "POST", { iso: 0x60 });
    expect((await res.json()).mode).toBe("low");
    expect(readSavedCameraSettings(dataDir, "low")).toEqual({ iso: 0x60 });
    expect(readSavedCameraSettings(dataDir, "high")).toEqual({});
  });

  it("test shot uses exactly that camera and answers 409 when it's down", async () => {
    let res = await req("/camera/test-shot?camera=low", "POST");
    expect(res.status).toBe(200);
    expect(manager.captureExact).toHaveBeenCalledWith(expect.any(String), "low");
    manager.captureExact.mockRejectedValueOnce(new CameraUnavailableError("The low camera is not connected"));
    res = await req("/camera/test-shot?camera=low", "POST");
    expect(res.status).toBe(409);
  });

  it("GET /cameras lists both slots with the remembered serials", async () => {
    writeCameraSerials(dataDir, { high: "SN-A" });
    expect(await (await req("/cameras")).json()).toEqual({
      slots: {
        high: { connected: true, model: "Canon EOS R100", serial: "SN-A", remembered: "SN-A" },
        low: { connected: true, model: "Canon EOS R100", serial: "SN-B", remembered: null },
      },
    });
  });

  it("remember saves the connected serials; swap exchanges them; both restart the workers", async () => {
    expect((await req("/cameras/remember", "POST")).status).toBe(200);
    expect(readCameraSerials(dataDir)).toEqual({ high: "SN-A", low: "SN-B" });
    expect((await req("/cameras/swap", "POST")).status).toBe(200);
    expect(readCameraSerials(dataDir)).toEqual({ high: "SN-B", low: "SN-A" });
    expect(manager.restartCanonWorkers).toHaveBeenCalledTimes(2);
  });

  it("remember with no camera connected is a 409", async () => {
    manager.getStatus.mockReturnValueOnce({ ...status, canonSerial: null, low: null } as never);
    expect((await req("/cameras/remember", "POST")).status).toBe(409);
  });
});
```

Run: `npx vitest run tests/camera.routes.dual.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement the routes.** In `src/server/routes.ts`:

Imports: add `readCameraSerials, writeCameraSerials, CameraSerials` from `../camera/camerasStore`, and `CameraSlot` from `../events/types`.

Near the other schemas:

```ts
const CameraBodySchema = z.object({ camera: z.enum(["high", "low"]).default("high") });
/** ?camera=low means the low camera; anything else (or nothing) means high. */
const slotParam = (req: Request): CameraSlot => (req.query["camera"] === "low" ? "low" : "high");
```

`/liveview`: `const camera = slotParam(req);` before the loop, and `ctx.cameraManager.getLiveviewFrame(camera)`.

`/capture`: change the handler to take `req`, and at the start:

```ts
    const parsed = CameraBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'camera must be "high" or "low"' });
      return;
    }
```

Then:
- `ctx.cameraManager.capture(originalsDir(config), parsed.data.camera)`;
- `camera: result.camera` in `insertCapture`;
- `camera: result.camera` in the 201 JSON.

`/camera/prefocus`:

```ts
  router.post("/camera/prefocus", (req: Request, res: Response) => {
    const parsed = CameraBodySchema.safeParse(req.body ?? {});
    ctx.cameraManager.prefocus(parsed.success ? parsed.data.camera : "high").catch(() => undefined);
    res.status(202).json({});
  });
```

Settings routes:
- `GET /camera/settings`: `const slot = slotParam(req);`, then `getCanonSettings(slot)` and `readSavedCameraSettings(dataDir, slot)`.
- `POST /camera/settings`: the same, with `setCanonSettings(parsed.data as SettingChanges, slot)` and `saveCameraSettings(dataDir, slot, accepted)`.
- `/camera/settings/reset`: `clearSavedCameraSettings(dataDir, slotParam(req))`.

`/camera/test-shot`:

```ts
      const shot = await ctx.cameraManager.captureExact(path.join(ctx.configStore.current.storage.dataDir, "test-shots"), slotParam(req));
```

and in its catch:

```ts
      res.status(err instanceof CameraUnavailableError ? 409 : 503).json({ error: err instanceof Error ? err.message : String(err) });
```

New routes, after test-shot:

```ts
  // --- Camera pairing (which body is high, which low) --------------------
  router.get("/cameras", (_req: Request, res: Response) => {
    const s = ctx.cameraManager.getStatus();
    const saved = readCameraSerials(ctx.configStore.current.storage.dataDir);
    res.json({
      slots: {
        high: { connected: s.canonConnected, model: s.canonModel, serial: s.canonSerial, remembered: saved.high ?? null },
        low: { connected: s.low?.connected ?? false, model: s.low?.model ?? null, serial: s.low?.serial ?? null, remembered: saved.low ?? null },
      },
    });
  });

  /** Saves `serials` (dropping empty slots) and re-opens both cameras with them. */
  const pair = (res: Response, serials: Partial<Record<CameraSlot, string | null | undefined>>) => {
    const next: CameraSerials = {};
    if (serials.high) next.high = serials.high;
    if (serials.low) next.low = serials.low;
    if (!next.high && !next.low) {
      res.status(409).json({ error: "No camera to pair - connect the cameras first" });
      return;
    }
    writeCameraSerials(ctx.configStore.current.storage.dataDir, next);
    ctx.cameraManager.restartCanonWorkers();
    res.json({ saved: next });
  };

  router.post("/cameras/remember", (_req: Request, res: Response) => {
    const s = ctx.cameraManager.getStatus();
    const saved = readCameraSerials(ctx.configStore.current.storage.dataDir);
    pair(res, { high: s.canonSerial ?? saved.high, low: s.low?.serial ?? saved.low });
  });

  router.post("/cameras/swap", (_req: Request, res: Response) => {
    const s = ctx.cameraManager.getStatus();
    const saved = readCameraSerials(ctx.configStore.current.storage.dataDir);
    pair(res, { high: saved.low ?? s.low?.serial, low: saved.high ?? s.canonSerial });
  });
```

- [ ] **Step 5: Run everything.** Run `npm run typecheck && npx vitest run`. Expected: PASS, including `camera.settings.test.ts`, whose mock gets the `"high"` default.

- [ ] **Step 6: Commit.**

```bash
git add src/outbox src/server/routes.ts tests/camera.routes.dual.test.ts tests/outbox.migration.test.ts
git commit -m "feat(api): camera param on capture/liveview/prefocus/settings/test-shot; /cameras pairing routes"
```

---

### Task 7: Health, startup wiring and README

**Files:**
- Modify: `src/health/healthReport.ts`, `src/server/routes.ts` (the `/health` handler), `src/index.ts`, `README.md`
- Test: `tests/health.camera.test.ts`

**Interfaces:**
- Consumes:
  - `CameraManagerStatus.low`, `canonSerial` and `canonModel` (Task 5).
  - `usesCamera` (Task 4).
  - `workerTarget` and `readCameraSerials` (Task 3).
  - `migrateLegacyCameraSettings` (Task 3).
- Produces:
  - `HealthInputs.layoutUsesLow?: boolean`.
  - `HealthReport.cameras`, shaped as below:

```ts
  cameras: {
    high: { connected: boolean; model: string | null; serial: string | null; detail: CameraDetail | null };
    low: { connected: boolean; model: string | null; serial: string | null; detail: CameraDetail | null } | null;
  };
```

- [ ] **Step 1: Write the failing tests.** In `tests/health.camera.test.ts`:
  - Extend `report()`'s `over` with `low?: { connected: boolean; detail?: CameraDetail | null } | null; layoutUsesLow?: boolean`.
  - Pass them in: add `canonModel: "Canon EOS R100", canonSerial: "SN-A", low: over.low === undefined ? null : over.low && { connected: over.low.connected, model: "Canon EOS R100", serial: "SN-B", detail: over.low.detail ?? null }` to `camera`, and `layoutUsesLow: over.layoutUsesLow ?? false` to the inputs.
  - Append:

```ts
describe("/health with a low camera", () => {
  it("has no low alerts or block without a low slot", () => {
    const r = report();
    expect(r.cameras.low).toBeNull();
    expect(r.cameras.high).toMatchObject({ connected: true, serial: "SN-A" });
    expect(codes(r).some((c) => c.includes("-low"))).toBe(false);
  });

  it("a missing low camera is an error only when the layout uses it", () => {
    expect(codes(report({ low: { connected: false }, layoutUsesLow: true }))).toContain("error:camera-low-none");
    expect(codes(report({ low: { connected: false }, layoutUsesLow: false }))).toContain("warn:camera-low-none");
    expect(codes(report({ low: { connected: true }, layoutUsesLow: true }))).not.toContain("error:camera-low-none");
  });

  it("reports the low camera's battery and RAW-only problems with a -low suffix", () => {
    const c = codes(report({ low: { connected: true, detail: detail({ battery: 10, quality: { label: "RAW", hasJpeg: false } }) } }));
    expect(c).toContain("warn:camera-battery-low-low");
    expect(c).toContain("error:camera-raw-only-low");
  });
});
```

Run: `npx vitest run tests/health.camera.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement health.** In `src/health/healthReport.ts`:
  - Add `layoutUsesLow?: boolean;` to `HealthInputs` ("Whether the session layout has a photo on the low camera").
  - Add the `cameras` block to `HealthReport`.
  - Replace the existing raw-only and battery pushes with a helper that is called for both cameras:

```ts
/** Problems one Canon reports about itself. The low camera's codes get a "-low" suffix. */
function cameraDetailAlerts(detail: CameraDetail | null, suffix: "" | "-low", name: string): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  if (detail?.quality && !detail.quality.hasJpeg) {
    alerts.push({
      level: "error",
      code: `camera-raw-only${suffix}`,
      message: `${name} is set to ${detail.quality.label} with no JPEG - captures will fail. Set image quality to include JPEG.`,
    });
  }
  if (typeof detail?.battery === "number" && detail.battery < 20) {
    alerts.push({
      level: "warn",
      code: `camera-battery-low${suffix}`,
      message: `${name} battery at ${detail.battery}% - swap or charge it at the next gap.`,
    });
  }
  return alerts;
}
```

In `buildHealthReport`, where the two old pushes were:

```ts
  alerts.push(...cameraDetailAlerts(detail, "", "The camera"));
  if (camera.low) {
    if (!camera.low.connected) {
      alerts.push(
        inputs.layoutUsesLow
          ? { level: "error", code: "camera-low-none", message: "The low camera is not connected - its photos are being taken by the high camera. Check it is on and its USB cable is plugged in." }
          : { level: "warn", code: "camera-low-none", message: "The low camera is not connected (the current layout doesn't use it)." }
      );
    }
    alerts.push(...cameraDetailAlerts(camera.low.detail, "-low", "The low camera"));
  }
```

No existing test asserts these message texts; the high camera's messages change from "Camera battery at…" to "The camera battery at…", which is fine.

In the returned object, add:

```ts
    cameras: {
      high: { connected: camera.canonConnected, model: camera.canonModel ?? null, serial: camera.canonSerial ?? null, detail },
      low: camera.low ?? null,
    },
```

(The `?? null` keeps old test fixtures, which lack the new fields, working at runtime.)

- [ ] **Step 3: Feed `layoutUsesLow` from `/health`.** In `src/server/routes.ts`, import `usesCamera` from `../compositor/template`. In the `/health` handler, before `res.json(...)`:

```ts
    // Whether a missing low camera affects guests right now. A layout that won't
    // load is reported by /session; here it just counts as "not using it".
    let layoutUsesLow = false;
    try {
      layoutUsesLow = usesCamera(
        loadTemplate(config.compositing.templateDir, readSessionSettings(config.storage.dataDir).templateId),
        "low"
      );
    } catch {
      /* see /session */
    }
```

and pass `layoutUsesLow` into `buildHealthReport`.

- [ ] **Step 4: Wire two sources at startup.** In `src/index.ts`:
  - Import `readCameraSerials, workerTarget` and `migrateLegacyCameraSettings`.
  - Replace the canon source block with:

```ts
  // `driver` is read once at startup; switching it needs a service restart.
  const canonConfig = config.capture.canon;
  const dataDir = config.storage.dataDir;
  migrateLegacyCameraSettings(dataDir);
  // Each slot's spawn re-reads cameras.json, so a Swap/Remember takes effect on the worker restart.
  const edsdkSlot = (slot: CameraSlot) =>
    new EdsdkSource(
      () => spawnWorker(canonConfig.edsdkDllPath, workerTarget(readCameraSerials(dataDir), slot)),
      () => readSavedCameraSettings(dataDir, slot)
    );
  const canonSource = canonConfig.driver === "edsdk" ? edsdkSlot("high") : new CanonTetheredSource(canonConfig);
  const webcamSource = new WebcamSource(config.capture.webcam);
  const cameraManager = new CameraManager(
    { canon: canonSource, webcam: webcamSource, ...(canonConfig.driver === "edsdk" ? { canonLow: edsdkSlot("low") } : {}) },
    config.capture.sourcePreference,
    eventBus
  );
```

Add `import { CameraSlot } from "./events/types";`.

- [ ] **Step 5: Document it.** In `README.md`, after the EDSDK section, add a "Two cameras (high and low)" section covering:
  - Both cameras must be R100s (or other EDSDK bodies) on the `edsdk` driver.
  - First run: both are picked arbitrarily. Use Camera tab → Swap/Remember, or `POST /cameras/swap` and `POST /cameras/remember`, which write `<dataDir>/cameras.json`.
  - Settings live in `camera-high.json` and `camera-low.json`; an old `camera.json` is moved to `camera-high.json` on first start.
  - Layouts set `"camera": "low"` on a photo element (the editor switch arrives in PR 2).
  - Fallback: low → high → webcam.
  - `/health` has `cameras` and `camera-low-none`.
  - Hardware checks are pending the 64-bit DLL, and approach 2 is the fallback if two processes can't share EDSDK.

- [ ] **Step 6: Run everything.** Run `npm run typecheck && npx vitest run`. Expected: PASS (all suites).

- [ ] **Step 7: Commit.**

```bash
git add src/health/healthReport.ts src/server/routes.ts src/index.ts README.md tests/health.camera.test.ts
git commit -m "feat(health): per-camera block and low-camera alerts; start two EDSDK slots"
```

---

## After the last task

- Push `feat/dual-camera` and open the PR. The spec, this plan and the 7 task commits go in.
- Deploy is an agent restart only; no kiosk change and no new dependency.
- Under the digiCamControl driver, `/health` gains `cameras` (with `low: null`), and everything else is unchanged. Verify after the restart:
  - `GET /cameras` returns `low: { connected: false, … }`;
  - `POST /capture` with no body still returns 201 with `camera: "high"`. Only do this with a camera attached and the user's OK, because it takes a real photo.
