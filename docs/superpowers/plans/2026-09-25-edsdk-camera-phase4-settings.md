# EDSDK camera control: phase 4 (Camera settings tab) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator changes ISO, aperture, shutter speed, white balance, exposure compensation and image quality from a new **Camera** tab in the kiosk operator panel.
- The tab offers only the values the camera accepts in its current mode.
- A **Test shot** button shows a photo without printing or saving it as a guest photo.
- Accepted changes are saved to `<dataDir>/camera.json` and re-applied every time the camera reconnects.

**Architecture:**
- **Worker:** gains `getSettings()` and `setSettings(changes)`, using `EdsGetPropertyDesc` for the allowed values and `EdsSetPropertyData` to change them. Both run under the worker's capture lock.
- **`EdsdkSource`:** exposes them. When the camera connects, it applies the saved settings, which come from a loader callback.
- **`CameraManager`:** forwards to the Canon source. If that source can't do settings (the digiCamControl driver) or no camera is connected, it throws `CameraUnavailableError`, which the routes turn into 409.
- **`cameraSettingsStore.ts`:** owns `camera.json`.
- **Routes:** `GET/POST /camera/settings`, `POST /camera/settings/reset` and `POST /camera/test-shot`.

**Tech Stack:** TypeScript (strict, CommonJS agent; Vite/React kiosk), zod, vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-edsdk-camera-design.md`, section "Camera settings (operator panel)".

## Global Constraints

- Settable properties:
  - ISO `kEdsPropID_ISOSpeed` (0x402);
  - Aperture `kEdsPropID_Av` (0x405);
  - Shutter `kEdsPropID_Tv` (0x406);
  - White balance `kEdsPropID_WhiteBalance` (0x106);
  - Exposure compensation `kEdsPropID_ExposureCompensation` (0x407);
  - Image quality `kEdsPropID_ImageQuality` (0x100).
- `kEdsPropID_AEMode` is read-only (the mode dial is physical).
- Options come from `EdsGetPropertyDesc`. A property whose description is empty is shown disabled.
- Raw codes map to labels through the tables in Task 1. Unknown codes show as hex.
- Changes are saved to `<dataDir>/camera.json` and re-applied on every (re)connect. Values the camera rejects in its current mode are skipped and logged. "Use camera's current settings" deletes `camera.json`.
- Routes use GET/POST only, with the existing bearer auth. When the Canon source can't do settings or no camera is connected, the settings routes return **409** with a message.
- `POST /camera/test-shot` captures through the active source into a temp folder, returns `image/jpeg` and deletes the file. There is no capture row, no print and no sync. It works with any driver.
- The worker never runs a settings operation during a capture: settings requests go through the same lock as capture.
- Tests never load koffi or the DLL.
- Comments, commits and PR text are in English. Every commit ends with a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` line naming the model that wrote it.
- There are no new dependencies. Deploy the agent first (restart), then the kiosk.

---

### Task 1: Setting labels (pure)

**Files:**
- Modify: `src/camera/edsdk/cameraLabels.ts`
- Test: `tests/edsdk.labels.test.ts` (append)

**Interfaces:**
- Produces:
  - `export type SettingKey = "iso" | "av" | "tv" | "wb" | "ev" | "quality";`
  - `settingLabel(key: SettingKey, code: number): string`
  - `qualityLabel(raw: number): string`

- [ ] **Step 1: Append the failing tests**

```ts
import { qualityLabel, settingLabel } from "../src/camera/edsdk/cameraLabels";

describe("setting labels", () => {
  it("ISO, aperture and shutter from Canon's tables", () => {
    expect(settingLabel("iso", 0)).toBe("ISO Auto");
    expect(settingLabel("iso", 0x58)).toBe("ISO 400");
    expect(settingLabel("iso", 0x70)).toBe("ISO 3200");
    expect(settingLabel("av", 0x30)).toBe("f/5.6");
    expect(settingLabel("av", 0x2d)).toBe("f/5");
    expect(settingLabel("tv", 0x70)).toBe("1/125");
    expect(settingLabel("tv", 0x38)).toBe('1"');
    expect(settingLabel("tv", 0x0c)).toBe("Bulb");
    expect(settingLabel("iso", 0x99)).toBe("0x99");
  });

  it("white balance, including signed codes", () => {
    expect(settingLabel("wb", 0)).toBe("Auto (ambience)");
    expect(settingLabel("wb", 23)).toBe("Auto (white)");
    expect(settingLabel("wb", 1)).toBe("Daylight");
    expect(settingLabel("wb", 0xffffffff)).toBe("0xFFFFFFFF");
  });

  it("exposure compensation in thirds and halves", () => {
    expect(settingLabel("ev", 0)).toBe("0");
    expect(settingLabel("ev", 0x03)).toBe("+1/3");
    expect(settingLabel("ev", 0x0b)).toBe("+1 1/3");
    expect(settingLabel("ev", 0x10)).toBe("+2");
    expect(settingLabel("ev", 0xfb)).toBe("-2/3");
    expect(settingLabel("ev", 0xf8)).toBe("-1");
    expect(settingLabel("ev", 0x04)).toBe("+1/2");
    expect(settingLabel("ev", 0x01)).toBe("0x1");
  });

  it("image quality with size and compression", () => {
    expect(qualityLabel(0x0013ff0f)).toBe("L JPEG Fine");
    expect(qualityLabel(0x0112ff0f)).toBe("M JPEG Normal");
    expect(qualityLabel(0x0064ff0f)).toBe("RAW");
    expect(qualityLabel(0x00640013)).toBe("RAW + L JPEG Fine");
    expect(qualityLabel(0x0083ff0f)).toBe("L HEIF Fine");
    expect(settingLabel("quality", 0x0013ff0f)).toBe("L JPEG Fine");
  });
});
```

(Merge the import into the file's existing import from `cameraLabels`.)

- [ ] **Step 2: Run to verify it fails.** `npx vitest run tests/edsdk.labels.test.ts`: the new tests FAIL.

- [ ] **Step 3: Implement (append to `cameraLabels.ts`)**

```ts
export type SettingKey = "iso" | "av" | "tv" | "wb" | "ev" | "quality";

// Canon EDSDK code tables (EDSDK API reference, "Property Data").
const ISO: Record<number, string> = {
  0x00: "Auto", 0x28: "6", 0x30: "12", 0x38: "25", 0x40: "50", 0x48: "100", 0x4b: "125", 0x4d: "160", 0x50: "200",
  0x53: "250", 0x55: "320", 0x58: "400", 0x5b: "500", 0x5d: "640", 0x60: "800", 0x63: "1000", 0x65: "1250",
  0x68: "1600", 0x6b: "2000", 0x6d: "2500", 0x70: "3200", 0x73: "4000", 0x75: "5000", 0x78: "6400", 0x7b: "8000",
  0x7d: "10000", 0x80: "12800", 0x83: "16000", 0x85: "20000", 0x88: "25600", 0x8b: "32000", 0x8d: "40000",
  0x90: "51200", 0x98: "102400",
};

const AV: Record<number, string> = {
  0x08: "1", 0x0b: "1.1", 0x0c: "1.2", 0x0d: "1.2", 0x10: "1.4", 0x13: "1.6", 0x14: "1.8", 0x15: "1.8", 0x18: "2",
  0x1b: "2.2", 0x1c: "2.5", 0x1d: "2.5", 0x20: "2.8", 0x23: "3.2", 0x24: "3.5", 0x25: "3.5", 0x28: "4", 0x2b: "4.5",
  0x2c: "4.5", 0x2d: "5", 0x30: "5.6", 0x33: "6.3", 0x34: "6.7", 0x35: "7.1", 0x38: "8", 0x3b: "9", 0x3c: "9.5",
  0x3d: "10", 0x40: "11", 0x43: "13", 0x44: "13", 0x45: "14", 0x48: "16", 0x4b: "18", 0x4c: "19", 0x4d: "20",
  0x50: "22", 0x53: "25", 0x54: "27", 0x55: "29", 0x58: "32", 0x5b: "36", 0x5c: "38", 0x5d: "40", 0x60: "45",
  0x63: "51", 0x64: "54", 0x65: "57", 0x68: "64", 0x6b: "72", 0x6c: "76", 0x6d: "80", 0x70: "91",
};

const TV: Record<number, string> = {
  0x0c: "Bulb", 0x10: '30"', 0x13: '25"', 0x14: '20"', 0x15: '20"', 0x18: '15"', 0x1b: '13"', 0x1c: '10"',
  0x1d: '10"', 0x20: '8"', 0x23: '6"', 0x24: '6"', 0x25: '5"', 0x28: '4"', 0x2b: '3"2', 0x2c: '3"', 0x2d: '2"5',
  0x30: '2"', 0x33: '1"6', 0x34: '1"5', 0x35: '1"3', 0x38: '1"', 0x3b: '0"8', 0x3c: '0"7', 0x3d: '0"6',
  0x40: '0"5', 0x43: '0"4', 0x44: '0"3', 0x45: '0"3', 0x48: "1/4", 0x4b: "1/5", 0x4c: "1/6", 0x4d: "1/6",
  0x50: "1/8", 0x53: "1/10", 0x54: "1/10", 0x55: "1/13", 0x58: "1/15", 0x5b: "1/20", 0x5c: "1/20", 0x5d: "1/25",
  0x60: "1/30", 0x63: "1/40", 0x64: "1/45", 0x65: "1/50", 0x68: "1/60", 0x6b: "1/80", 0x6c: "1/90",
  0x6d: "1/100", 0x70: "1/125", 0x73: "1/160", 0x74: "1/180", 0x75: "1/200", 0x78: "1/250", 0x7b: "1/320",
  0x7c: "1/350", 0x7d: "1/400", 0x80: "1/500", 0x83: "1/640", 0x84: "1/750", 0x85: "1/800", 0x88: "1/1000",
  0x8b: "1/1250", 0x8c: "1/1500", 0x8d: "1/1600", 0x90: "1/2000", 0x93: "1/2500", 0x94: "1/3000",
  0x95: "1/3200", 0x98: "1/4000", 0x9b: "1/5000", 0x9c: "1/6000", 0x9d: "1/6400", 0xa0: "1/8000",
};

const WB: Record<number, string> = {
  0: "Auto (ambience)", 23: "Auto (white)", 1: "Daylight", 2: "Cloudy", 3: "Tungsten",
  4: "Fluorescent", 5: "Flash", 6: "Custom", 8: "Shade", 9: "Colour temperature",
};

/** EDSDK stores exposure compensation as a signed byte in eighths of a stop: 3 = 1/3, 4 = 1/2, 5 = 2/3. */
function evLabel(code: number): string {
  const byte = code & 0xff;
  const signed = byte > 127 ? byte - 256 : byte;
  if (signed === 0) return "0";
  const eighths = Math.abs(signed);
  const whole = Math.floor(eighths / 8);
  const frac = ({ 0: "", 3: "1/3", 4: "1/2", 5: "2/3" } as Record<number, string>)[eighths % 8];
  if (frac === undefined) return hexCode(code);
  return `${signed < 0 ? "-" : "+"}${[whole || "", frac].filter(Boolean).join(" ")}`;
}

const SIZE: Record<number, string> = { 0: "L", 1: "M", 2: "S", 5: "M1", 6: "M2", 0xe: "S1", 0xf: "S2", 0x10: "S3" };
const COMPRESS: Record<number, string> = { 2: "Normal", 3: "Fine", 5: "Super Fine" };
const RAW_SIZE: Record<number, string> = { 0: "RAW", 1: "M-RAW", 2: "S-RAW" };

/** One image of the pair: RAW sizes have their own names; JPEG/HEIF read as "<size> <format> <compression>". */
function imagePart(size: number, format: number, compress: number): string {
  if (format === 2 || format === 4 || format === 6) return RAW_SIZE[size] ?? "RAW";
  const name = FORMAT_NAMES[format] ?? hexCode(format);
  return [SIZE[size] ?? hexCode(size), name, COMPRESS[compress]].filter(Boolean).join(" ");
}

/** Full label for a quality option, e.g. 0x00640013 = "RAW + L JPEG Fine". */
export function qualityLabel(raw: number): string {
  const parts: string[] = [];
  const primaryFormat = (raw >>> 20) & 0xf;
  const secondaryFormat = (raw >>> 4) & 0xf;
  if (primaryFormat) parts.push(imagePart((raw >>> 24) & 0xff, primaryFormat, (raw >>> 16) & 0xf));
  if (secondaryFormat) parts.push(imagePart((raw >>> 8) & 0xff, secondaryFormat, raw & 0xf));
  return parts.join(" + ") || hexCode(raw);
}

export function settingLabel(key: SettingKey, code: number): string {
  switch (key) {
    case "iso": return ISO[code] !== undefined ? `ISO ${ISO[code]}` : hexCode(code);
    case "av": return AV[code] !== undefined ? `f/${AV[code]}` : hexCode(code);
    case "tv": return TV[code] ?? hexCode(code);
    case "wb": return WB[code] ?? hexCode(code);
    case "ev": return evLabel(code);
    case "quality": return qualityLabel(code);
  }
}
```

`hexCode` and `FORMAT_NAMES` already exist in this file from phase 3; reuse them. If `FORMAT_NAMES` is declared after these functions, move it up so it's defined before use.

- [ ] **Step 4: Run the tests.** `npx vitest run tests/edsdk.labels.test.ts`, then `npx tsc -p tsconfig.json --noEmit`. Expected: PASS (266 + 4 = 270 in the full suite) and tsc clean.

- [ ] **Step 5: Commit.** `git add src tests && git commit -m "feat(edsdk): labels for ISO, aperture, shutter, WB, exposure and quality options" -m "Co-Authored-By: ..."`

---

### Task 2: Worker settings (EdsGetPropertyDesc, get/set)

**Files:**
- Modify:
  - `src/camera/edsdk/edsdkApi.ts` (property ids, `getPropertyDesc`)
  - `src/camera/edsdk/edsdkNative.ts` (the `EdsGetPropertyDesc` binding)
  - `src/camera/edsdk/protocol.ts` (the settings types and requests)
  - `src/camera/edsdk/CameraWorker.ts` (`getSettings`, `setSettings`)
  - `src/camera/edsdk/worker.ts` (dispatch under `captureLock`)
  - `tests/helpers/fakeEdsdk.ts` (`descs`, `getPropertyDesc`, `rejectSet`)
- Test: `tests/edsdk.worker.test.ts` (append)

**Interfaces:**
- Produces, in `protocol.ts`:
  ```ts
  import { SettingKey } from "./cameraLabels";
  export type { SettingKey };
  export interface SettingOption { code: number; label: string }
  export interface CameraSettings {
    mode: string | null;
    settings: Record<SettingKey, { value: SettingOption | null; options: SettingOption[] }>;
    /** Keys from the last setSettings that the camera refused (not allowed in this mode, or the set failed). */
    rejected: SettingKey[];
  }
  export type SettingChanges = Partial<Record<SettingKey, number>>;
  ```
- `RequestBody` gains `| { type: "getSettings" } | { type: "setSettings"; changes: SettingChanges }`.
- `WorkerResponse`'s ok `result` widens to `Uint8Array | CameraSettings | null`.
- `EdsApi.getPropertyDesc(cam: EdsRef, prop: number): { err: number; values: number[] }`.
- `CameraWorker.getSettings(): CameraSettings` and `CameraWorker.setSettings(changes: SettingChanges): CameraSettings`. Both throw `Error("No Canon camera connected")` with no camera, and `Error("Camera is busy capturing")` if called while `capturing`.

- [ ] **Step 1: Extend the fake (`tests/helpers/fakeEdsdk.ts`)**

```ts
  /** Allowed values per property, as EdsGetPropertyDesc would report; missing = empty (not settable now). */
  descs = new Map<number, number[]>();
  /** Props whose setU32 fails with this error code. */
  rejectSet = new Map<number, number>();
  getPropertyDesc(_cam: EdsRef, prop: number): { err: number; values: number[] } {
    return { err: 0, values: this.descs.get(prop) ?? [] };
  }
```

In `setU32`, before storing: `const reject = this.rejectSet.get(prop); if (reject) return reject;`.

- [ ] **Step 2: Append the failing worker tests**

```ts
describe("CameraWorker settings", () => {
  beforeEach(() => {
    makeWorker();
    eds.props.set(EDS.PROP_AE_MODE, 2); // Av
    eds.props.set(EDS.PROP_ISO, 0x58);
    eds.props.set(EDS.PROP_AV, 0x30);
    eds.props.set(EDS.PROP_TV, 0x70);
    eds.props.set(EDS.PROP_WHITE_BALANCE, 0);
    eds.props.set(EDS.PROP_EXPOSURE_COMP, 0);
    eds.props.set(EDS.PROP_IMAGE_QUALITY, 0x0013ff0f);
    eds.descs.set(EDS.PROP_ISO, [0, 0x48, 0x58, 0x60]);
    eds.descs.set(EDS.PROP_AV, [0x28, 0x30, 0x38]);
    // Tv has no allowed values: in Av mode the camera picks the shutter speed
    eds.descs.set(EDS.PROP_WHITE_BALANCE, [0, 1, 2]);
    eds.descs.set(EDS.PROP_EXPOSURE_COMP, [0xf8, 0, 0x08]);
    eds.descs.set(EDS.PROP_IMAGE_QUALITY, [0x0013ff0f, 0x00640013]);
    worker.tick();
  });

  it("reports current values and the allowed options, with labels", () => {
    const s = worker.getSettings();
    expect(s.mode).toBe("Av");
    expect(s.settings.iso).toEqual({
      value: { code: 0x58, label: "ISO 400" },
      options: [
        { code: 0, label: "ISO Auto" }, { code: 0x48, label: "ISO 100" },
        { code: 0x58, label: "ISO 400" }, { code: 0x60, label: "ISO 800" },
      ],
    });
    expect(s.settings.tv.options).toEqual([]); // disabled in Av mode
    expect(s.settings.tv.value).toEqual({ code: 0x70, label: "1/125" });
    expect(s.rejected).toEqual([]);
  });

  it("sets allowed values and reports disallowed or failed ones as rejected", () => {
    eds.rejectSet.set(EDS.PROP_WHITE_BALANCE, EDS.ERR_DEVICE_BUSY);
    const s = worker.setSettings({ iso: 0x60, tv: 0x78, wb: 1 });
    expect(eds.props.get(EDS.PROP_ISO)).toBe(0x60);
    expect(eds.props.get(EDS.PROP_TV)).toBe(0x70); // unchanged: not in the allowed list
    expect(s.settings.iso.value).toEqual({ code: 0x60, label: "ISO 800" });
    expect(s.rejected.sort()).toEqual(["tv", "wb"]);
  });

  it("refuses with no camera or during a capture", async () => {
    eds.photoNames = [];
    const capture = worker.capture(dest());
    expect(() => worker.getSettings()).toThrow("busy capturing");
    expect(() => worker.setSettings({ iso: 0x48 })).toThrow("busy capturing");
    await expect(capture).rejects.toThrow("timed out");
    eds.unplug();
    worker.tick();
    expect(() => worker.getSettings()).toThrow("No Canon camera connected");
  });
});
```

- [ ] **Step 3: Run to verify it fails.** `npx vitest run tests/edsdk.worker.test.ts`: the new tests FAIL.

- [ ] **Step 4: Implement**

`edsdkApi.ts`:
- Add the property ids: `PROP_WHITE_BALANCE: 0x106, PROP_ISO: 0x402, PROP_AV: 0x405, PROP_TV: 0x406, PROP_EXPOSURE_COMP: 0x407` (`PROP_IMAGE_QUALITY` and `PROP_AE_MODE` exist already).
- Add to `EdsApi`:
  ```ts
    /** Values this property may be set to right now (empty = not settable in the current mode). */
    getPropertyDesc(cam: EdsRef, prop: number): { err: number; values: number[] };
  ```

`edsdkNative.ts`:

```ts
  koffi.struct("EdsPropertyDesc", {
    form: "int32",
    access: "int32",
    numElements: "int32",
    propDesc: koffi.array("int32", 128),
  });
  // in f:
    getPropertyDesc: lib.func("uint32 __stdcall EdsGetPropertyDesc(void *ref, uint32 id, _Out_ EdsPropertyDesc *desc)"),
  // in the returned object:
    getPropertyDesc(cam, prop) {
      const desc: { numElements?: number; propDesc?: number[] } = {};
      const err = f.getPropertyDesc(cam, prop, desc);
      if (err !== 0) return { err, values: [] };
      const n = Math.max(0, Math.min(128, desc.numElements ?? 0));
      // Codes are unsigned property values; int32 decoding would turn e.g. 0xFFFFFFFF into -1.
      return { err: 0, values: Array.from(desc.propDesc ?? []).slice(0, n).map((v) => v >>> 0) };
    },
```

`protocol.ts`: add the types from Interfaces, the two `RequestBody` variants, and widen `WorkerResponse`.

`CameraWorker.ts`:

```ts
import { SettingKey, settingLabel } from "./cameraLabels";
import { CameraSettings, SettingChanges } from "./protocol";

const SETTING_PROPS: Record<SettingKey, number> = {
  iso: EDS.PROP_ISO, av: EDS.PROP_AV, tv: EDS.PROP_TV,
  wb: EDS.PROP_WHITE_BALANCE, ev: EDS.PROP_EXPOSURE_COMP, quality: EDS.PROP_IMAGE_QUALITY,
};
const SETTING_KEYS = Object.keys(SETTING_PROPS) as SettingKey[];

  private settingsCam(): EdsRef {
    if (!this.cam) throw new Error("No Canon camera connected");
    if (this.capturing) throw new Error("Camera is busy capturing");
    return this.cam;
  }

  /** Current value and allowed options for each setting the operator panel can change. */
  getSettings(rejected: SettingKey[] = []): CameraSettings {
    const cam = this.settingsCam();
    const mode = this.eds.getU32(cam, EDS.PROP_AE_MODE);
    const settings = {} as CameraSettings["settings"];
    for (const key of SETTING_KEYS) {
      const prop = SETTING_PROPS[key];
      const current = this.eds.getU32(cam, prop);
      const desc = this.eds.getPropertyDesc(cam, prop);
      settings[key] = {
        value: current.err === EDS.ERR_OK ? { code: current.value, label: settingLabel(key, current.value) } : null,
        options: (desc.err === EDS.ERR_OK ? desc.values : []).map((code) => ({ code, label: settingLabel(key, code) })),
      };
    }
    return { mode: mode.err === EDS.ERR_OK ? aeModeLabel(mode.value) : null, settings, rejected };
  }

  /** Applies each change the camera allows in its current mode; the rest come back in `rejected`. */
  setSettings(changes: SettingChanges): CameraSettings {
    const cam = this.settingsCam();
    const rejected: SettingKey[] = [];
    for (const key of SETTING_KEYS) {
      const code = changes[key];
      if (code === undefined) continue;
      const prop = SETTING_PROPS[key];
      const allowed = this.eds.getPropertyDesc(cam, prop);
      const err = allowed.err === EDS.ERR_OK && allowed.values.includes(code >>> 0) ? this.eds.setU32(cam, prop, code >>> 0) : -1;
      if (err !== EDS.ERR_OK) {
        rejected.push(key);
        if (err !== -1) this.check(err, `set ${key}`);
      }
    }
    return this.getSettings(rejected);
  }
```

Note: `check()` may disconnect on a disconnect-class error. Then `getSettings` throws "No Canon camera connected", which is correct.

`worker.ts`, in `handle()`:

```ts
    // Same lock as capture: a settings change must never land mid-shot.
    case "getSettings":
      return captureLock.run(async () => worker.getSettings());
    case "setSettings":
      return captureLock.run(async () => worker.setSettings(request.changes));
```

- [ ] **Step 5: Run the tests.** Run the worker test file, then the full suite (270 + 3 = 273), then tsc. Expected: all pass, and tsc is clean.

- [ ] **Step 6: Commit.** `feat(edsdk): worker reads allowed camera settings and applies changes`

---

### Task 3: Agent side (source, store, manager, routes)

**Files:**
- Create: `src/camera/cameraSettingsStore.ts`
- Modify:
  - `src/camera/CameraSource.ts` (`CameraUnavailableError`, optional `getSettings?`/`setSettings?`)
  - `src/camera/edsdk/EdsdkSource.ts` (`getSettings`, `setSettings`, apply saved on connect, constructor loader)
  - `src/camera/CameraManager.ts` (`getCanonSettings`, `setCanonSettings`)
  - `src/index.ts` (pass the saved-settings loader)
  - `src/server/routes.ts` (four routes)
  - `README.md` (API rows)
- Test: new `tests/camera.settings.test.ts`; append to `tests/edsdk.source.test.ts`

**Interfaces:**
- Consumes: `CameraSettings`, `SettingChanges`, `SettingKey` (Task 2)
- Produces:
  - `class CameraUnavailableError extends Error` (in `CameraSource.ts`)
  - `CameraSource.getSettings?(): Promise<CameraSettings>` and `CameraSource.setSettings?(changes: SettingChanges): Promise<CameraSettings>`
  - `EdsdkSource` constructor: `(spawn: () => WorkerHandle, loadSaved: () => SettingChanges = () => ({}))`
  - `CameraManager.getCanonSettings(): Promise<CameraSettings>` and `CameraManager.setCanonSettings(changes): Promise<CameraSettings>`, which throw `CameraUnavailableError`
  - `readSavedCameraSettings(dataDir): SettingChanges`, `saveCameraSettings(dataDir, changes): SettingChanges` (merges, returns the result), `clearSavedCameraSettings(dataDir): void`, `SettingChangesSchema`
  - HTTP:
    - `GET /camera/settings` → `CameraSettings & { saved }`
    - `POST /camera/settings` (a partial of codes) → `CameraSettings & { saved }`, 400 on an invalid body
    - `POST /camera/settings/reset` → `{ saved: {} }`
    - `POST /camera/test-shot` → image/jpeg, with an `X-Capture-Source` header
    - 409 `{ error }` when `CameraUnavailableError` is thrown

- [ ] **Step 1: Write the failing tests**

Append to `tests/edsdk.source.test.ts`:

```ts
describe("EdsdkSource settings", () => {
  it("refuses settings until the camera is connected", async () => {
    await expect(source.getSettings()).rejects.toThrow("No Canon camera connected");
  });

  it("applies the saved settings when the camera connects, and forwards get/set", async () => {
    await source.shutdown();
    workers = [];
    source = new EdsdkSource(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }, () => ({ iso: 0x58 }));
    await source.initialize();
    const settings = { mode: "M", settings: {} as never, rejected: [] };
    current().reply = (req) => ({ id: req.id, ok: true, result: settings as never });
    current().push({ type: "state", connected: true, model: "Canon EOS R100" });
    await vi.advanceTimersByTimeAsync(0);
    expect(current().sent.find((r) => r.type === "setSettings")).toMatchObject({ changes: { iso: 0x58 } });
    await expect(source.getSettings()).resolves.toEqual(settings);
    await source.setSettings({ av: 0x30 });
    expect(current().sent.at(-1)).toMatchObject({ type: "setSettings", changes: { av: 0x30 } });
  });
});
```

(`source` and `workers` are module-level `let`s in this file; if they're `const`, adapt minimally. The `afterEach` shutdown still runs.)

Create `tests/camera.settings.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import sharp from "sharp";
import { CameraUnavailableError } from "../src/camera/CameraSource";
import { readSavedCameraSettings, saveCameraSettings, clearSavedCameraSettings } from "../src/camera/cameraSettingsStore";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";

describe("camera settings store", () => {
  it("merges, reads back and clears", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "camset-"));
    expect(readSavedCameraSettings(dir)).toEqual({});
    saveCameraSettings(dir, { iso: 0x58 });
    expect(saveCameraSettings(dir, { av: 0x30 })).toEqual({ iso: 0x58, av: 0x30 });
    expect(readSavedCameraSettings(dir)).toEqual({ iso: 0x58, av: 0x30 });
    clearSavedCameraSettings(dir);
    expect(readSavedCameraSettings(dir)).toEqual({});
  });

  it("treats a corrupt file as nothing saved", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "camset-"));
    writeFileSync(path.join(dir, "camera.json"), "{nope");
    expect(readSavedCameraSettings(dir)).toEqual({});
  });
});

describe("camera settings routes", () => {
  const SECRET = "test-secret";
  const dataDir = mkdtempSync(path.join(tmpdir(), "camroutes-"));
  const result = { mode: "M", settings: {}, rejected: [] as string[] };
  const manager = {
    getCanonSettings: vi.fn(async () => result),
    setCanonSettings: vi.fn(async () => result),
    capture: vi.fn(async (dir: string) => {
      mkdirSync(dir, { recursive: true }); // real sources create destDir themselves
      const filePath = path.join(dir, "shot.jpg");
      await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } }).jpeg().toFile(filePath);
      return { filePath, width: 4, height: 4, source: "canon" };
    }),
  };
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
      configStore: { current: { agent: { allowedOrigins: [], sharedSecret: SECRET }, storage: { dataDir } } },
      cameraManager: manager,
    } as unknown as AgentContext;
    server = buildHttpApp(ctx).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });
  beforeEach(() => {
    clearSavedCameraSettings(dataDir);
    result.rejected = [];
  });

  it("GET returns the camera's settings plus what is saved", async () => {
    saveCameraSettings(dataDir, { iso: 0x48 });
    const res = await req("/camera/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...result, saved: { iso: 0x48 } });
  });

  it("POST applies, saves only what the camera accepted, and validates the body", async () => {
    result.rejected = ["tv"];
    const res = await req("/camera/settings", "POST", { iso: 0x60, tv: 0x78 });
    expect(res.status).toBe(200);
    expect(manager.setCanonSettings).toHaveBeenCalledWith({ iso: 0x60, tv: 0x78 });
    expect((await res.json()).saved).toEqual({ iso: 0x60 });
    expect(readSavedCameraSettings(dataDir)).toEqual({ iso: 0x60 });
    expect((await req("/camera/settings", "POST", { iso: "high" })).status).toBe(400);
    expect((await req("/camera/settings", "POST", { shutter: 5 })).status).toBe(400);
  });

  it("answers 409 when the camera can't do settings", async () => {
    manager.getCanonSettings.mockRejectedValueOnce(new CameraUnavailableError("Camera settings need the EDSDK driver"));
    const res = await req("/camera/settings");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/EDSDK/);
  });

  it("reset clears the saved settings", async () => {
    saveCameraSettings(dataDir, { iso: 0x48 });
    const res = await req("/camera/settings/reset", "POST");
    expect(await res.json()).toEqual({ saved: {} });
    expect(readSavedCameraSettings(dataDir)).toEqual({});
  });

  it("test shot returns the JPEG and leaves nothing behind", async () => {
    const res = await req("/camera/test-shot", "POST");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/image\/jpeg/);
    expect(res.headers.get("x-capture-source")).toBe("canon");
    expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width).toBe(4);
    const [dir] = manager.capture.mock.calls.at(-1)!;
    expect(existsSync(path.join(dir, "shot.jpg"))).toBe(false);
  });
});
```

Add to the same file a small `CameraManager` test:

```ts
import { CameraManager } from "../src/camera/CameraManager";
import { EventBus } from "../src/events/eventBus";
import { CameraSource } from "../src/camera/CameraSource";

describe("CameraManager canon settings", () => {
  const base = (kind: "canon" | "webcam"): CameraSource => ({
    kind, initialize: async () => true, shutdown: async () => {}, isHealthy: async () => true,
    capture: async () => ({ filePath: "x", width: 1, height: 1 }), getLiveviewFrame: async () => null, getModel: () => kind,
  });

  it("throws CameraUnavailableError when the Canon source can't do settings", async () => {
    const m = new CameraManager({ canon: base("canon"), webcam: base("webcam") }, "canon", new EventBus(), 60_000);
    await expect(m.getCanonSettings()).rejects.toBeInstanceOf(CameraUnavailableError);
    await expect(m.setCanonSettings({ iso: 1 })).rejects.toBeInstanceOf(CameraUnavailableError);
  });

  it("forwards to a source that can", async () => {
    const getSettings = vi.fn(async () => ({ mode: "M", settings: {} as never, rejected: [] }));
    const m = new CameraManager({ canon: { ...base("canon"), getSettings }, webcam: base("webcam") }, "canon", new EventBus(), 60_000);
    await expect(m.getCanonSettings()).resolves.toMatchObject({ mode: "M" });
  });
});
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/camera.settings.test.ts tests/edsdk.source.test.ts`: the new tests FAIL.

- [ ] **Step 3: Implement**

`src/camera/CameraSource.ts`:

```ts
import { CameraSettings, SettingChanges } from "./edsdk/protocol";

/** The camera can't do what was asked right now (wrong driver, or not connected) - the routes turn this into 409. */
export class CameraUnavailableError extends Error {}

  // in the interface:
  /** Optional: read the operator-adjustable settings and what they may be set to. */
  getSettings?(): Promise<CameraSettings>;
  /** Optional: change settings; refused ones come back in `rejected`. */
  setSettings?(changes: SettingChanges): Promise<CameraSettings>;
```

`src/camera/cameraSettingsStore.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SettingChanges } from "./edsdk/protocol";

/**
 * The operator's camera settings (raw EDSDK codes), kept next to session.json
 * and re-applied whenever the camera reconnects - so a battery swap or a guest
 * fiddling with the dials doesn't silently change how the photos look.
 */
const code = z.number().int().nonnegative();
export const SettingChangesSchema = z
  .object({ iso: code, av: code, tv: code, wb: code, ev: code, quality: code })
  .partial()
  .strict();

const file = (dataDir: string) => path.join(dataDir, "camera.json");

export function readSavedCameraSettings(dataDir: string): SettingChanges {
  if (!existsSync(file(dataDir))) return {};
  try {
    return SettingChangesSchema.parse(JSON.parse(readFileSync(file(dataDir), "utf-8")));
  } catch {
    return {};
  }
}

/** Merges `changes` into what's saved and returns the result. */
export function saveCameraSettings(dataDir: string, changes: SettingChanges): SettingChanges {
  const merged = { ...readSavedCameraSettings(dataDir), ...changes };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file(dataDir), JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

export function clearSavedCameraSettings(dataDir: string): void {
  rmSync(file(dataDir), { force: true });
}
```

Codes are unsigned (the worker sends `>>> 0` values), so a nonnegative check is right. If a WB code arrives as a large unsigned number such as 0xFFFFFFFF, it still passes `int`.

`src/camera/edsdk/EdsdkSource.ts`:
- Change the constructor to `constructor(private readonly spawn: () => WorkerHandle, private readonly loadSaved: () => SettingChanges = () => ({})) {}`.
- Widen `request()`'s return to `Promise<Uint8Array | CameraSettings | null>`. Keep the existing callers working: cast in `getLiveviewFrame`, e.g. `as Uint8Array | null`.
- Add:
  ```ts
  async getSettings(): Promise<CameraSettings> {
    if (!this.connected) throw new CameraUnavailableError("No Canon camera connected");
    return (await this.request({ type: "getSettings" }, TIMEOUT_MS.other)) as CameraSettings;
  }

  async setSettings(changes: SettingChanges): Promise<CameraSettings> {
    if (!this.connected) throw new CameraUnavailableError("No Canon camera connected");
    return (await this.request({ type: "setSettings", changes }, TIMEOUT_MS.other)) as CameraSettings;
  }

  /** Re-applies the operator's saved settings after every (re)connect. */
  private async applySaved(): Promise<void> {
    const saved = this.loadSaved();
    if (Object.keys(saved).length === 0) return;
    try {
      const result = await this.setSettings(saved);
      if (result.rejected.length) log.warn(`Camera refused saved settings in its current mode: ${result.rejected.join(", ")}`);
    } catch (err) {
      log.warn("Could not apply saved camera settings", err);
    }
  }
  ```
- In `onMessage`'s state branch, when `message.connected` becomes true, call `void this.applySaved();` after updating the fields.

`src/camera/CameraManager.ts`:

```ts
  /** Operator-panel camera settings; only a source with settings support (EDSDK) can do this. */
  async getCanonSettings(): Promise<CameraSettings> {
    const canon = this.sources.canon;
    if (!canon.getSettings) throw new CameraUnavailableError("Camera settings need the EDSDK driver");
    return canon.getSettings();
  }

  async setCanonSettings(changes: SettingChanges): Promise<CameraSettings> {
    const canon = this.sources.canon;
    if (!canon.setSettings) throw new CameraUnavailableError("Camera settings need the EDSDK driver");
    return canon.setSettings(changes);
  }
```

`src/index.ts`: pass the loader, `new EdsdkSource(() => spawnWorker(canonConfig.edsdkDllPath), () => readSavedCameraSettings(config.storage.dataDir))`. `config` is the startup config already in scope there; `dataDir` changes need a restart anyway.

`src/server/routes.ts`: add the routes next to `/camera/prefocus`:

```ts
  // --- Camera settings (operator panel) ---------------------------------
  const cameraError = (res: Response, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(err instanceof CameraUnavailableError ? 409 : 500).json({ error: message });
  };

  router.get("/camera/settings", asyncHandler(async (_req: Request, res: Response) => {
    try {
      const settings = await ctx.cameraManager.getCanonSettings();
      res.json({ ...settings, saved: readSavedCameraSettings(ctx.configStore.current.storage.dataDir) });
    } catch (err) {
      cameraError(res, err);
    }
  }));

  router.post("/camera/settings", asyncHandler(async (req: Request, res: Response) => {
    const parsed = SettingChangesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "expected { iso?, av?, tv?, wb?, ev?, quality? } as EDSDK codes" });
      return;
    }
    try {
      const settings = await ctx.cameraManager.setCanonSettings(parsed.data);
      // Save only what the camera took, so a reconnect doesn't keep retrying a value it refuses.
      const accepted = Object.fromEntries(
        Object.entries(parsed.data).filter(([key]) => !settings.rejected.includes(key as SettingKey))
      );
      const saved = saveCameraSettings(ctx.configStore.current.storage.dataDir, accepted);
      res.json({ ...settings, saved });
    } catch (err) {
      cameraError(res, err);
    }
  }));

  router.post("/camera/settings/reset", (_req: Request, res: Response) => {
    clearSavedCameraSettings(ctx.configStore.current.storage.dataDir);
    res.json({ saved: {} });
  });

  // A photo for the operator to judge the settings by: never a capture row,
  // never printed, never synced, and deleted once sent.
  router.post("/camera/test-shot", asyncHandler(async (_req: Request, res: Response) => {
    let file: string | null = null;
    try {
      const shot = await ctx.cameraManager.capture(path.join(ctx.configStore.current.storage.dataDir, "test-shots"));
      file = shot.filePath;
      res.setHeader("X-Capture-Source", shot.source);
      res.type("image/jpeg").send(await readFile(file));
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (file) await unlink(file).catch(() => undefined);
    }
  }));
```

Import `readFile` from `node:fs/promises` (merge with the existing import), `CameraUnavailableError` from `../camera/CameraSource`, the store functions and `SettingChangesSchema` from `../camera/cameraSettingsStore`, and `SettingKey` from `../camera/edsdk/protocol`.

In the README API section, add rows for the four routes, following the existing format:
- the GET and POST settings: EDSDK only, 409 otherwise; POST saves what the camera accepted;
- reset;
- test-shot: any driver, not saved, printed or synced.

- [ ] **Step 4: Run the tests.** Run the two test files, then the full suite (273 + 10 = 283), then tsc. Expected: all pass, and tsc is clean.

- [ ] **Step 5: Commit.** `feat(camera): settings API, saved camera.json re-applied on connect, test shot`

---

### Task 4: Kiosk Camera tab

**Files:**
- Create: `kiosk/src/CameraTab.tsx`
- Modify:
  - `kiosk/src/agent.ts` (types and calls)
  - `kiosk/src/Operator.tsx` (the third tab)
  - `kiosk/src/styles.css` (`.camera-live`)

**Interfaces:**
- Consumes: the four routes (Task 3).

- [ ] **Step 1: The client in `kiosk/src/agent.ts`**

```ts
export type SettingKey = "iso" | "av" | "tv" | "wb" | "ev" | "quality";
export interface SettingOption { code: number; label: string }
export interface CameraSettings {
  mode: string | null;
  settings: Record<SettingKey, { value: SettingOption | null; options: SettingOption[] }>;
  rejected: SettingKey[];
  saved: Partial<Record<SettingKey, number>>;
}

  // in the `agent` object:
  cameraSettings: () => call<CameraSettings>("GET", "/camera/settings"),
  setCameraSettings: (changes: Partial<Record<SettingKey, number>>) => call<CameraSettings>("POST", "/camera/settings", changes),
  resetCameraSettings: () => call<{ saved: Record<string, never> }>("POST", "/camera/settings/reset"),
  testShot: () => callBlob("/camera/test-shot", {}),
```

- [ ] **Step 2: `kiosk/src/CameraTab.tsx`**

```tsx
import { useEffect, useState } from "react";
import { agent, agentUrl, CameraSettings, SettingKey } from "./agent";

const LABELS: Record<SettingKey, string> = {
  iso: "ISO", av: "Aperture", tv: "Shutter speed", wb: "White balance", ev: "Exposure compensation", quality: "Image quality",
};
const KEYS = Object.keys(LABELS) as SettingKey[];

/** Operator camera controls: only values the camera accepts right now, a test shot, and saved settings. */
export default function CameraTab() {
  const [s, setS] = useState<CameraSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<string | null>(null);

  const load = () => agent.cameraSettings().then((r) => { setS(r); setError(""); }, (e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);
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
      const r = await agent.setCameraSettings({ [key]: code });
      setS(r);
      setError(r.rejected.length ? `The camera refused: ${r.rejected.map((k) => LABELS[k]).join(", ")}` : "");
    });

  return (
    <div className="row gap-40 camera-tab">
      <div className="col gap-20">
        <img className="camera-live" src={agentUrl("/liveview")} alt="Live view" />
        {shot && <img className="camera-live" src={shot} alt="Test shot" />}
        <div className="row gap-20">
          <button type="button" className="btn primary sm" disabled={busy}
            onClick={() => run(async () => setShot(URL.createObjectURL(await agent.testShot())))}>Test shot</button>
          <button type="button" className="btn outline sm" disabled={busy}
            onClick={() => run(async () => { await agent.resetCameraSettings(); await load(); })}>Use camera's current settings</button>
        </div>
      </div>
      <div className="col gap-24 grow">
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
```

- [ ] **Step 3: Wire it into `kiosk/src/Operator.tsx`**
- Import `CameraTab from "./CameraTab"`.
- Widen the tab state to `"status" | "settings" | "camera"`.
- Add a third seg button, `Camera`, after `Settings`.
- In the render, change `tab === "status" ? <StatusTab /> : <SettingsTab .../>` to a three-way switch: status → `<StatusTab />`, camera → `<CameraTab />`, otherwise the existing `<SettingsTab ... />`.

- [ ] **Step 4: Style.** Append to `kiosk/src/styles.css`:

```css
/* Operator Camera tab: live view and the last test shot, side by side with the controls. */
.camera-live { width: 640px; aspect-ratio: 3 / 2; object-fit: contain; border-radius: 16px; background: #000; }
```

- [ ] **Step 5: Verify.** Run `npm run build` and `npx vitest run` in `kiosk/`. Expected: the build is clean and 23 tests pass.

- [ ] **Step 6: Commit.** `feat(kiosk): Camera tab - adjust camera settings, test shot, saved settings`

---

### Deploy and live check (controller, after merge, with the user)

1. The agent:
   1. `git pull --ff-only && npm run build` (no new dependencies);
   2. the user restarts the service;
   3. check that `ranAt` changed;
   4. `GET /camera/settings` answers **409** "Camera settings need the EDSDK driver" (digiCamControl is still active);
   5. `POST /camera/test-shot` works through digiCamControl (one real shot, no print).
2. The kiosk: deploy per `kiosk/README.md`. The user reloads the kiosk. The Camera tab shows the 409 message, the live view and a working Test shot.
3. With EDSDK (phase 1 Task 6):
   - the options match what the R100 allows in M and in Av;
   - a change applies;
   - `camera.json` is written and re-applied after a camera power cycle;
   - a Tv change in Av mode is shown as refused;
   - the `EdsGetPropertyDesc` binding returns plausible values (it hasn't been run against real EDSDK yet).
