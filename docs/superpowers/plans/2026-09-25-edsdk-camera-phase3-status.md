# EDSDK camera control: phase 3 (camera status) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/health` reports real camera status (driver, battery, mode dial, AF mode, image quality, last camera error) and raises three new alerts. The kiosk operator panel's Status tab shows them.

**Architecture:**
- The EDSDK worker reads four camera properties when it connects and then every 5 s (never during a capture). It pushes a `status` event only when something changed. It also records a `lastError` for the camera problems an operator should know about.
- `EdsdkSource` caches the latest status and exposes it through a new optional `CameraSource.getDetail()`.
- `CameraManager.getStatus()` includes the Canon source's detail.
- The `/health` route adds the configured driver and, for the EDSDK driver only, whether digiCamControl is running.
- `buildHealthReport` turns all of this into fields and alerts.

**Tech Stack:** TypeScript (strict, CommonJS agent; Vite/React kiosk), vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-edsdk-camera-design.md`, section "Camera status".

## Global Constraints

- The `/health` `camera` object gains:
  - `driver`;
  - `battery`: a percentage, `"ac"`, or null;
  - `mode`;
  - `afMode`;
  - `quality`;
  - `lastError`: `{ message, at }` or null.

  With the digiCamControl driver, `driver` is `"digicamcontrol"` and the rest are null.
- New alerts:
  - `camera-battery-low`: **warn**, when the battery is below 20% (and not on AC).
  - `camera-raw-only`: **error**, when the quality setting produces no JPEG. Captures time out, because the worker only accepts JPEG.
  - `camera-digicamcontrol-conflict`: **error**, when `CameraControl.exe` is running while the driver is EDSDK.
- With the EDSDK driver, the existing `camera-none` message must not tell the operator to check digiCamControl.
- The worker never reads properties during a capture. It pushes `status` only when the status changes.
- The kiosk's Status tab shows these fields on the CAMERA card, plus the last camera issue if there is one.
- Tests never load koffi or the DLL.
- Comments, commit messages and PR text are in English. Every commit ends with a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` line naming the model that wrote it.
- There are no new dependencies. Deploy the agent first (restart), then the kiosk.

## Decisions made here (inside the spec's scope)

| Property | EDSDK id | Mapping |
|---|---|---|
| Battery | `kEdsPropID_BatteryLevel` 0x8 | 0xFFFFFFFF becomes `"ac"`; 0-100 becomes that percentage; anything else becomes null |
| Mode dial | `kEdsPropID_AEMode` 0x400 | 0 P, 1 Tv, 2 Av, 3 M, 4 Bulb, 9 Auto, 19 Creative Auto, 20 Movie, 22 Scene Intelligent Auto, 25 SCN; anything else becomes `"0x<hex>"` |
| AF mode | `kEdsPropID_AFMode` 0x404 | 0 One-Shot, 1 AI Servo, 2 AI Focus, 3 Manual; anything else becomes hex |
| Quality | `kEdsPropID_ImageQuality` 0x100 | Formats come from bits 20-23 (primary) and 4-7 (secondary): 1 JPEG; 2, 4 and 6 RAW; 8 HEIF; 0 is unused. The label joins the used formats with "+", RAW first, e.g. "RAW+JPEG". An unknown format becomes `"0x<n>"`. `hasJpeg` is true when either slot is 1. |

What goes into `lastError` (worker side):
- AF failed and the shot was taken without AF;
- the shutter failed;
- the capture timed out;
- the download failed;
- the camera disconnected (with its reason).

On the agent side, `EdsdkSource` adds one: the worker exited unexpectedly.

The status poll runs every 5 s while connected and idle.

---

### Task 1: Worker status + EdsdkSource detail

**Files:**
- Create: `src/camera/edsdk/cameraLabels.ts`
- Modify:
  - `src/camera/edsdk/edsdkApi.ts` (property ids)
  - `src/camera/edsdk/protocol.ts` (`CameraDetail`, the `status` event)
  - `src/camera/edsdk/CameraWorker.ts` (the poll, lastError, emit on change)
  - `src/camera/edsdk/EdsdkSource.ts` (cache the status, `getDetail()`, lastError on worker exit)
  - `src/camera/CameraSource.ts` (optional `getDetail?()`)
- Test: new `tests/edsdk.labels.test.ts`; `tests/edsdk.worker.test.ts`, `tests/edsdk.source.test.ts`

**Interfaces:**
- Produces:
  - `CameraDetail` (in `protocol.ts`):
    ```ts
    export interface CameraDetail {
      battery: number | "ac" | null;
      mode: string | null;
      afMode: string | null;
      quality: { label: string; hasJpeg: boolean } | null;
      lastError: { message: string; at: string } | null;
    }
    ```
  - `WorkerEvent` gains `{ type: "status"; detail: CameraDetail }`.
  - `batteryLevel(raw: number): number | "ac" | null`, `aeModeLabel(raw: number): string`, `afModeLabel(raw: number): string`, `imageQuality(raw: number): { label: string; hasJpeg: boolean }` (in `cameraLabels.ts`).
  - `CameraSource.getDetail?(): CameraDetail | null`.
  - `EdsdkSource.getDetail(): CameraDetail | null`.

- [ ] **Step 1: Write the failing label tests in `tests/edsdk.labels.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { aeModeLabel, afModeLabel, batteryLevel, imageQuality } from "../src/camera/edsdk/cameraLabels";

describe("camera labels", () => {
  it("battery: AC, percent, or unknown", () => {
    expect(batteryLevel(0xffffffff)).toBe("ac");
    expect(batteryLevel(80)).toBe(80);
    expect(batteryLevel(0)).toBe(0);
    expect(batteryLevel(101)).toBeNull();
  });

  it("mode dial and AF mode, with hex for the unknown", () => {
    expect(aeModeLabel(3)).toBe("M");
    expect(aeModeLabel(2)).toBe("Av");
    expect(aeModeLabel(22)).toBe("Scene Intelligent Auto");
    expect(aeModeLabel(0x33)).toBe("0x33");
    expect(afModeLabel(1)).toBe("AI Servo");
    expect(afModeLabel(3)).toBe("Manual");
    expect(afModeLabel(7)).toBe("0x7");
  });

  it("image quality: formats and whether a JPEG comes out", () => {
    expect(imageQuality(0x0013ff0f)).toEqual({ label: "JPEG", hasJpeg: true }); // L JPEG Fine
    expect(imageQuality(0x0064ff0f)).toEqual({ label: "RAW", hasJpeg: false }); // RAW only
    expect(imageQuality(0x00640013)).toEqual({ label: "RAW+JPEG", hasJpeg: true }); // RAW + L JPEG Fine
    expect(imageQuality(0x0083ff0f)).toEqual({ label: "HEIF", hasJpeg: false });
    expect(imageQuality(0x00f3ff0f)).toEqual({ label: "0xF", hasJpeg: false });
  });
});
```

- [ ] **Step 2: Write the failing worker and source tests**

Append to `tests/edsdk.worker.test.ts`:

```ts
describe("CameraWorker status", () => {
  const statuses = () => events.filter((e) => e.type === "status");

  beforeEach(() => {
    makeWorker();
    eds.props.set(EDS.PROP_BATTERY_LEVEL, 80);
    eds.props.set(EDS.PROP_AE_MODE, 3);
    eds.props.set(EDS.PROP_AF_MODE, 1);
    eds.props.set(EDS.PROP_IMAGE_QUALITY, 0x00640013);
    worker.tick(); // connects and reads the status once
  });

  it("reports the camera's status right after connecting", () => {
    expect(statuses().at(-1)).toEqual({
      type: "status",
      detail: { battery: 80, mode: "M", afMode: "AI Servo", quality: { label: "RAW+JPEG", hasJpeg: true }, lastError: null },
    });
  });

  it("re-reads every 5 s and only reports changes", () => {
    const before = statuses().length;
    clock.advance(5_000);
    worker.tick();
    expect(statuses()).toHaveLength(before); // unchanged, so nothing sent
    eds.props.set(EDS.PROP_BATTERY_LEVEL, 15);
    clock.advance(4_999);
    worker.tick();
    expect(statuses()).toHaveLength(before); // not due yet
    clock.advance(1);
    worker.tick();
    expect(statuses().at(-1)).toMatchObject({ detail: { battery: 15 } });
  });

  it("records an autofocus fallback as lastError", async () => {
    eds.pressResults = [EDS.ERR_TAKE_PICTURE_AF_NG];
    await worker.capture(dest());
    expect(statuses().at(-1)).toMatchObject({
      detail: { lastError: { message: "Autofocus failed - took the shot without autofocus" } },
    });
  });

  it("records a failed capture as lastError", async () => {
    eds.photoNames = [];
    await expect(worker.capture(dest())).rejects.toThrow("timed out");
    expect(statuses().at(-1)).toMatchObject({ detail: { lastError: { message: "Canon capture timed out waiting for the photo" } } });
  });

  it("clears the readings on disconnect but keeps why as lastError", () => {
    eds.unplug();
    worker.tick();
    expect(statuses().at(-1)).toMatchObject({
      detail: { battery: null, mode: null, afMode: null, quality: null, lastError: { message: "Camera disconnected (camera shut down)" } },
    });
  });

  it("never reads properties during a capture", async () => {
    eds.photoNames = [];
    const capture = worker.capture(dest());
    eds.props.set(EDS.PROP_BATTERY_LEVEL, 10);
    clock.advance(5_000);
    worker.tick();
    expect(statuses().some((s) => s.type === "status" && s.detail.battery === 10)).toBe(false);
    await expect(capture).rejects.toThrow("timed out");
  });
});
```

`lastError.at` is `new Date(clock.now()).toISOString()`. The tests match only on `message`.

Append to `tests/edsdk.source.test.ts`:

```ts
describe("EdsdkSource detail", () => {
  it("caches the worker's status and keeps lastError when the worker dies", async () => {
    expect(source.getDetail()).toBeNull();
    const detail = { battery: "ac" as const, mode: "M", afMode: "AI Servo", quality: { label: "JPEG", hasJpeg: true }, lastError: null };
    current().push({ type: "status", detail });
    expect(source.getDetail()).toEqual(detail);

    current().emit("exit", 3);
    expect(source.getDetail()).toMatchObject({
      battery: null, mode: null, afMode: null, quality: null,
      lastError: { message: "Camera worker exited (code 3)" },
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/edsdk.labels.test.ts tests/edsdk.worker.test.ts tests/edsdk.source.test.ts`
Expected: the new tests FAIL (the module is missing, `EDS.PROP_BATTERY_LEVEL` is undefined, `getDetail` is not a function).

- [ ] **Step 4: Implement**

In `src/camera/edsdk/edsdkApi.ts`, next to `PROP_SAVE_TO`:

```ts
  PROP_BATTERY_LEVEL: 0x08,
  PROP_IMAGE_QUALITY: 0x100,
  PROP_AE_MODE: 0x400,
  PROP_AF_MODE: 0x404,
```

Create `src/camera/edsdk/cameraLabels.ts`:

```ts
/**
 * Raw EDSDK property codes -> what an operator reads on the Status tab.
 * Unknown codes show as hex rather than guessing.
 */

const hexCode = (n: number): string => `0x${(n >>> 0).toString(16).toUpperCase()}`;

const AE_MODES: Record<number, string> = {
  0: "P", 1: "Tv", 2: "Av", 3: "M", 4: "Bulb", 9: "Auto",
  19: "Creative Auto", 20: "Movie", 22: "Scene Intelligent Auto", 25: "SCN",
};

const AF_MODES: Record<number, string> = { 0: "One-Shot", 1: "AI Servo", 2: "AI Focus", 3: "Manual" };

/** 0xFFFFFFFF is how EDSDK says "on AC power"; 0-100 is a percentage. */
export function batteryLevel(raw: number): number | "ac" | null {
  if (raw >>> 0 === 0xffffffff) return "ac";
  return raw >= 0 && raw <= 100 ? raw : null;
}

export const aeModeLabel = (raw: number): string => AE_MODES[raw] ?? hexCode(raw);
export const afModeLabel = (raw: number): string => AF_MODES[raw] ?? hexCode(raw);

const FORMAT_NAMES: Record<number, string> = { 1: "JPEG", 2: "RAW", 4: "RAW", 6: "RAW", 8: "HEIF" };

/**
 * EdsImageQuality packs two images: the primary format is bits 20-23, the
 * secondary is bits 4-7 (0 = no image). e.g. 0x00640013 = RAW + L JPEG Fine.
 */
export function imageQuality(raw: number): { label: string; hasJpeg: boolean } {
  const formats = [(raw >>> 20) & 0xf, (raw >>> 4) & 0xf].filter((f) => f !== 0);
  const names = formats.map((f) => FORMAT_NAMES[f] ?? hexCode(f));
  names.sort((a, b) => (a === "RAW" ? -1 : b === "RAW" ? 1 : 0));
  return { label: names.join("+"), hasJpeg: formats.includes(1) };
}
```

In `src/camera/edsdk/protocol.ts`, add `CameraDetail` exactly as in Interfaces above, and add `| { type: "status"; detail: CameraDetail }` to `WorkerEvent`.

In `src/camera/edsdk/CameraWorker.ts`:

```ts
import { aeModeLabel, afModeLabel, batteryLevel, imageQuality } from "./cameraLabels";
import { CameraDetail, LogLevel, WorkerEvent } from "./protocol";

const STATUS_POLL_MS = 5_000;
```

Add these fields:

```ts
  private lastStatusAt = 0;
  private lastError: CameraDetail["lastError"] = null;
  /** JSON of the last status sent, so an unchanged poll sends nothing. */
  private lastStatusSent = "";
```

Add these private methods:

```ts
  private readStatus(): Omit<CameraDetail, "lastError"> {
    const cam = this.cam;
    if (!cam) return { battery: null, mode: null, afMode: null, quality: null };
    const read = (prop: number) => {
      const r = this.eds.getU32(cam, prop);
      return r.err === EDS.ERR_OK ? r.value : null;
    };
    const battery = read(EDS.PROP_BATTERY_LEVEL);
    const mode = read(EDS.PROP_AE_MODE);
    const af = read(EDS.PROP_AF_MODE);
    const quality = read(EDS.PROP_IMAGE_QUALITY);
    return {
      battery: battery === null ? null : batteryLevel(battery),
      mode: mode === null ? null : aeModeLabel(mode),
      afMode: af === null ? null : afModeLabel(af),
      quality: quality === null ? null : imageQuality(quality),
    };
  }

  /** Sends the current status if it differs from the last one sent. */
  private publishStatus(): void {
    const detail: CameraDetail = { ...this.readStatus(), lastError: this.lastError };
    const json = JSON.stringify(detail);
    if (json === this.lastStatusSent) return;
    this.lastStatusSent = json;
    this.emit({ type: "status", detail });
  }

  /** Remembers a problem an operator should see on the Status tab, and publishes it. */
  private recordError(message: string): void {
    this.lastError = { message, at: new Date(this.clock.now()).toISOString() };
    this.publishStatus();
  }
```

Wire them in:
- `scan()`: at the end of a successful connect (right after emitting `state: connected`), set `this.lastStatusAt = this.clock.now();` and call `this.publishStatus();`.
- `tick()`: in the connected branch, add:
  ```ts
      if (!this.capturing && now - this.lastStatusAt >= STATUS_POLL_MS) {
        this.lastStatusAt = now;
        this.publishStatus();
      }
  ```
- `disconnect(reason)`: after `this.cam = null;` and the existing clean-up, call `this.recordError(\`Camera disconnected (${reason})\`);`. `cam` is null by then, so `readStatus()` returns nulls.
- `capture()`:
  - in the AF fallback branch, after the existing warn log, call `this.recordError("Autofocus failed - took the shot without autofocus");`;
  - on each thrown failure (the shutter failed, the capture timed out, the download failed; not the "No Canon camera connected" guard), record its message first. The simplest way: wrap the body after the guard in `try { ... } catch (err) { this.recordError(err instanceof Error ? err.message : String(err)); throw err; } finally { ... }`, keeping the existing `finally`.
  - The disconnect-during-capture path already records its reason through `disconnect()`. Recording "Camera disconnected during capture" afterwards is fine: the last one wins.

In `src/camera/CameraSource.ts`:

```ts
import { CameraDetail } from "./edsdk/protocol";
...
  /** Optional: live camera detail for /health (battery, mode, ...). Null when unknown. */
  getDetail?(): CameraDetail | null;
```

In `src/camera/edsdk/EdsdkSource.ts`:
- Add the field `private detail: CameraDetail | null = null;` and the method `getDetail(): CameraDetail | null { return this.detail; }`.
- In `onMessage`, handle `message.type === "status"` with `this.detail = message.detail; return;`, before the log fallthrough.
- In `onExit`, after `this.connected = false;` and when the exit wasn't requested (`!this.stopping`), set:
  ```ts
      this.detail = {
        battery: null, mode: null, afMode: null, quality: null,
        lastError: { message: `Camera worker exited (code ${String(code)})`, at: new Date().toISOString() },
      };
  ```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/edsdk.labels.test.ts tests/edsdk.worker.test.ts tests/edsdk.source.test.ts`, then `npx vitest run`, then `npx tsc -p tsconfig.json --noEmit`.
Expected: all pass (249 + 3 label + 6 worker + 1 source = 259), and tsc is clean. If an existing worker test asserted an exact `events` list that now also contains `status` events, filter it to the event types it cares about. Don't weaken what it asserts.

- [ ] **Step 6: Commit**

```bash
git add src tests
git commit -m "feat(edsdk): camera status - battery, mode, AF, quality and last error" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 2: /health fields and alerts

**Files:**
- Modify:
  - `src/camera/CameraManager.ts` (`CameraManagerStatus.canonDetail`)
  - `src/health/healthReport.ts` (inputs, camera fields, alerts, the `camera-none` message)
  - `src/server/routes.ts` (the `/health` inputs: driver, digiCamControlRunning)
  - `tests/hotFolderStall.test.ts` (its `report()` helper passes the new required input)
- Test: new `tests/health.camera.test.ts`

**Interfaces:**
- Consumes: `CameraDetail`, `CameraSource.getDetail?()` (Task 1)
- Produces:
  - `CameraManagerStatus.canonDetail: CameraDetail | null`
  - `HealthInputs.canon: { driver: "digicamcontrol" | "edsdk"; digiCamControlRunning: boolean }`
  - `HealthReport.camera` gains `driver`, `battery`, `mode`, `afMode`, `quality`, `lastError`

- [ ] **Step 1: Write the failing tests in `tests/health.camera.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildHealthReport, HealthInputs } from "../src/health/healthReport";
import { CameraDetail } from "../src/camera/edsdk/protocol";

const detail = (over: Partial<CameraDetail> = {}): CameraDetail => ({
  battery: 80, mode: "M", afMode: "AI Servo", quality: { label: "JPEG", hasJpeg: true }, lastError: null, ...over,
});

function report(over: { canonDetail?: CameraDetail | null; driver?: "digicamcontrol" | "edsdk"; digiCamControlRunning?: boolean; activeSource?: string } = {}) {
  const inputs: HealthInputs = {
    camera: {
      activeSource: (over.activeSource ?? "canon") as never,
      activeModel: "Canon EOS R100",
      canonConnected: true,
      webcamConnected: false,
      preference: "canon",
      canonDetail: over.canonDetail === undefined ? detail() : over.canonDetail,
    },
    canon: { driver: over.driver ?? "edsdk", digiCamControlRunning: over.digiCamControlRunning ?? false },
    hotFolder: { path: "C:\\hot", writable: true },
    stalledPrints: { count: 0, oldestDroppedAt: null, oldestAgeSeconds: null, files: [] },
    printer: { reachable: true, ok: true, status: "STATUS_OK", model: "RX1HS", mediaRemaining: 500, mediaType: "4x6", serialNumber: null, lastUpdatedAt: null, staleMs: 0, error: null, statusFilePath: "x", raw: {} } as never,
    disk: { freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 },
    outbox: { queueDepth: 0, lastSyncAt: null, lastError: null, abandonedCount: 0 },
    eventId: "evt",
    thresholds: { lowDiskWarnBytes: 1, lowMediaWarnPrints: 30, outboxBacklogWarn: 50, expectedMediaType: "4x6" },
  };
  return buildHealthReport(inputs);
}

const codes = (r: ReturnType<typeof report>) => r.alerts.map((a) => `${a.level}:${a.code}`);

describe("/health camera status", () => {
  it("reports the driver and the camera detail", () => {
    const r = report({ canonDetail: detail({ battery: "ac", lastError: { message: "x", at: "t" } }) });
    expect(r.camera).toMatchObject({
      driver: "edsdk", battery: "ac", mode: "M", afMode: "AI Servo",
      quality: { label: "JPEG", hasJpeg: true }, lastError: { message: "x", at: "t" },
    });
    expect(r.overall).toBe("ok");
  });

  it("has nulls with the digiCamControl driver", () => {
    const r = report({ driver: "digicamcontrol", canonDetail: null });
    expect(r.camera).toMatchObject({ driver: "digicamcontrol", battery: null, mode: null, afMode: null, quality: null, lastError: null });
  });

  it("warns on a low battery but not on AC", () => {
    expect(codes(report({ canonDetail: detail({ battery: 19 }) }))).toContain("warn:camera-battery-low");
    expect(codes(report({ canonDetail: detail({ battery: 20 }) }))).not.toContain("warn:camera-battery-low");
    expect(codes(report({ canonDetail: detail({ battery: "ac" }) }))).not.toContain("warn:camera-battery-low");
  });

  it("errors when the camera would produce no JPEG", () => {
    expect(codes(report({ canonDetail: detail({ quality: { label: "RAW", hasJpeg: false } }) }))).toContain("error:camera-raw-only");
  });

  it("errors when digiCamControl is running alongside the EDSDK driver", () => {
    expect(codes(report({ digiCamControlRunning: true }))).toContain("error:camera-digicamcontrol-conflict");
    expect(codes(report({ driver: "digicamcontrol", digiCamControlRunning: true, canonDetail: null }))).not.toContain(
      "error:camera-digicamcontrol-conflict"
    );
  });

  it("does not blame digiCamControl for a missing camera under EDSDK", () => {
    const edsdk = report({ activeSource: "none" }).alerts.find((a) => a.code === "camera-none");
    expect(edsdk?.message).not.toMatch(/digiCamControl/);
    const dcc = report({ activeSource: "none", driver: "digicamcontrol", canonDetail: null }).alerts.find((a) => a.code === "camera-none");
    expect(dcc?.message).toMatch(/digiCamControl/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/health.camera.test.ts`
Expected: FAIL; `r.camera.driver` is undefined and the alert codes are missing.

- [ ] **Step 3: Implement**

`src/camera/CameraManager.ts`:
- Add `canonDetail: CameraDetail | null;` to `CameraManagerStatus`, importing the type from `./edsdk/protocol`.
- In `getStatus()`, add `canonDetail: this.sources.canon.getDetail?.() ?? null,`.

`src/health/healthReport.ts`:
- Import `CameraDetail`.
- Add to `HealthInputs`:
  ```ts
    /** How the Canon is driven, and for EDSDK whether digiCamControl is running too. */
    canon: { driver: "digicamcontrol" | "edsdk"; digiCamControlRunning: boolean };
  ```
- Extend `HealthReport.camera` with:
  ```ts
    driver: "digicamcontrol" | "edsdk";
    battery: CameraDetail["battery"];
    mode: string | null;
    afMode: string | null;
    quality: CameraDetail["quality"];
    lastError: CameraDetail["lastError"];
  ```
- In `buildHealthReport`, destructure `canon`. Change the `camera-none` message:
  ```ts
      message:
        canon.driver === "edsdk"
          ? "No camera available - captures will fail. Check the camera is on and its USB cable is plugged in."
          : "No camera available - captures will fail. Check USB and digiCamControl.",
  ```
- After the existing capture alerts, add:
  ```ts
    const detail = camera.canonDetail;
    if (canon.driver === "edsdk" && canon.digiCamControlRunning) {
      alerts.push({
        level: "error",
        code: "camera-digicamcontrol-conflict",
        message: "digiCamControl is running and holding the camera - close it (and remove it from startup) so the booth can use the camera.",
      });
    }
    if (detail?.quality && !detail.quality.hasJpeg) {
      alerts.push({
        level: "error",
        code: "camera-raw-only",
        message: `The camera is set to ${detail.quality.label} with no JPEG - captures will fail. Set image quality to include JPEG.`,
      });
    }
    if (typeof detail?.battery === "number" && detail.battery < 20) {
      alerts.push({
        level: "warn",
        code: "camera-battery-low",
        message: `Camera battery at ${detail.battery}% - swap or charge it at the next gap.`,
      });
    }
  ```
- In the returned `camera` object, add:
  ```ts
      driver: canon.driver,
      battery: detail?.battery ?? null,
      mode: detail?.mode ?? null,
      afMode: detail?.afMode ?? null,
      quality: detail?.quality ?? null,
      lastError: detail?.lastError ?? null,
  ```

`src/server/routes.ts`, the `/health` handler:
- Import `isDigiCamControlRunning` from `../camera/CanonTetheredSource`.
- Add a fifth entry to the `Promise.all`:
  ```ts
      config.capture.canon.driver === "edsdk" ? isDigiCamControlRunning().catch(() => false) : Promise.resolve(false),
  ```
  Destructure it as `digiCamControlRunning`.
- Pass `canon: { driver: config.capture.canon.driver, digiCamControlRunning }` to `buildHealthReport`.

`tests/hotFolderStall.test.ts`: in its `report()` helper, add `canon: { driver: "digicamcontrol", digiCamControlRunning: false },` to the `buildHealthReport` input, and `canonDetail: null` to its `healthyCamera` object.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/health.camera.test.ts tests/hotFolderStall.test.ts`, then `npx vitest run`, then `npx tsc -p tsconfig.json --noEmit`.
Expected: all pass (259 + 6 = 265), and tsc is clean.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(health): camera driver, battery, mode, AF, quality, last error and three new alerts" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 3: Kiosk Status tab

**Files:**
- Modify: `kiosk/src/agent.ts` (the `Health.camera` type)
- Modify: `kiosk/src/Operator.tsx` (the CAMERA card and the last-issue line)

**Interfaces:**
- Consumes: the `/health` camera fields (Task 2)

- [ ] **Step 1: Extend the type in `kiosk/src/agent.ts`**

Replace `camera: { activeSource: string; model: string | null };` in `Health` with:

```ts
  camera: {
    activeSource: string;
    model: string | null;
    driver?: "digicamcontrol" | "edsdk";
    battery?: number | "ac" | null;
    mode?: string | null;
    afMode?: string | null;
    quality?: { label: string; hasJpeg: boolean } | null;
    lastError?: { message: string; at: string } | null;
  };
```

The new fields are optional, so the kiosk still works against an older agent.

- [ ] **Step 2: Show them on the Status tab (`kiosk/src/Operator.tsx`)**

Add this helper above `StatusTab`:

```tsx
/** "Using canon · 80% · M · AI Servo · RAW+JPEG" - only the parts the agent knows. */
function cameraNote(c: Health["camera"]): string {
  if (c.activeSource === "none") return "No camera";
  const battery = c.battery === "ac" ? "AC power" : typeof c.battery === "number" ? `${c.battery}%` : null;
  return [`Using ${c.activeSource}`, battery, c.mode, c.afMode, c.quality?.label].filter(Boolean).join(" · ");
}
```

Import `Health` from `./agent`, adding it to the existing import.

Change the CAMERA card's `note` to `note={cameraNote(h.camera)}`.

Right after the `op-grid` div (still inside `{h && (...)}`), add:

```tsx
          {h.camera.lastError && (
            <div className="muted fs-24">
              Last camera issue ({time(h.camera.lastError.at)}): {h.camera.lastError.message}
            </div>
          )}
```

If the `{h && (...)}` block currently returns a single element, wrap both in a fragment (`<>...</>`).

- [ ] **Step 3: Verify**

Run in `kiosk/`: `npm run build` and `npx vitest run`.
Expected: the build is clean and 23 tests pass.

- [ ] **Step 4: Commit**

```bash
git add kiosk/src/agent.ts kiosk/src/Operator.tsx
git commit -m "feat(kiosk): show camera battery, mode, AF, quality and last issue on the Status tab" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Deploy and live check (controller, after merge, with the user)

1. The agent:
   1. `git pull --ff-only && npm run build` (no new dependencies);
   2. the user restarts the service;
   3. check that `ranAt` changed;
   4. check that `/health` shows `camera.driver: "digicamcontrol"` with null details and no new alerts.
2. The kiosk: robocopy `kiosk\src` with /MIR, copy the top-level files, then `npm run build` in `C:\BoothAgent\kiosk`. The user reloads the kiosk. The CAMERA card still reads "Using canon".
3. With EDSDK (phase 1 Task 6, once the 64-bit DLL is in):
   - the card shows AC power, M, AI Servo and the quality;
   - setting the quality to RAW only raises `camera-raw-only`;
   - opening digiCamControl raises `camera-digicamcontrol-conflict`;
   - a covered-lens shot shows the "Autofocus failed" last issue.
