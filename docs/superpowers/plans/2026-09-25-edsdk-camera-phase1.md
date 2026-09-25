# EDSDK camera control: phase 0 + 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revert the useless CaptureNoAf fallback (#46), then add an EDSDK-based Canon camera source. It runs in a supervised child process and handles capture, live view, autofocus-failure recovery, reconnect and keep-awake. It can be selected with `capture.canon.driver: "edsdk"`, while the default stays `digicamcontrol`.

**Architecture:** `EdsdkSource` implements the existing `CameraSource` interface. It forks `dist/camera/edsdk/worker.js` and talks to it over Node's IPC channel (`serialization: "advanced"`, so Buffers pass through). The worker wraps a pure-logic `CameraWorker` class that only sees an `EdsApi` interface:
- in production, `EdsApi` is `edsdkNative.ts` (koffi loading `EDSDK.dll`);
- in tests, it is a fake.

Nothing outside `src/camera/edsdk/` changes except the config, the wiring, preflight and the README.

**Tech Stack:** TypeScript (CommonJS, strict, `exactOptionalPropertyTypes`), Node 24 x64, koffi 3.x, vitest 5, sharp, zod.

**Spec:** `docs/superpowers/specs/2026-09-25-edsdk-camera-design.md`

## Global Constraints

- Every shutter press is followed by `PressShutterButton OFF` (0), whether the press succeeded or failed.
- On `0x8D01` (AF failed), take the shot with `Completely_NonAF` (0x10003), again followed by OFF.
- On `0x81` (busy), send OFF, wait 500 ms, retry the same press once, then OFF again.
- Photo transfer timeout: 10 s. Timeouts on the agent side: capture 12 s, frame 2 s, everything else 3 s.
- Live view turns on at the first frame request and off after 10 s with no frame request.
- Reconnect scan every 1 s. Keep-awake (`ExtendShutDownTimer`) every 60 s while connected.
- Supervision:
  - ping every 2 s;
  - after 2 missed pings, kill the worker;
  - respawn backoff 1 s, 2 s, 5 s (capped), reset on a `connected` state event;
  - shutdown grace 3 s.
- The EDSDK DLLs are never committed. The default DLL path is `C:\BoothAgent\edsdk\EDSDK.dll`.
- `capture.canon.driver` defaults to `"digicamcontrol"`, and the digiCamControl config fields stay required.
- Tests never load koffi or the DLL. Only `worker.ts` imports `edsdkNative.ts`.
- Code comments, commit messages and PR text are in English. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The agent is never built ahead of what the kiosk needs, and phase 1 needs no kiosk change.

---

## File structure

| File | Responsibility |
|---|---|
| `src/camera/edsdk/edsdkApi.ts` | `EdsApi` interface, EDSDK constants and error codes, `hex()`. No koffi. |
| `src/camera/edsdk/edsdkNative.ts` | `loadEdsdk(dllPath): EdsApi`, the koffi binding. Only imported by `worker.ts`. |
| `src/camera/edsdk/protocol.ts` | IPC message types shared by the worker and `EdsdkSource`. |
| `src/camera/edsdk/CameraWorker.ts` | All camera logic: connect/scan/reconnect, keep-awake, capture with AF recovery, live view, shutdown. |
| `src/camera/edsdk/worker.ts` | Child-process entry: tick loop, IPC dispatch, capture lock. |
| `src/camera/edsdk/EdsdkSource.ts` | `CameraSource` implementation: spawn, request/timeout, ping, respawn. |
| `src/config/schema.ts` | Add `driver` and `edsdkDllPath` to the Canon config (exported as `CanonConfigSchema`). |
| `src/index.ts` | Pick `EdsdkSource` or `CanonTetheredSource` by `driver`. |
| `src/startup/preflight.ts` | EDSDK checks: the DLL is present; digiCamControl is not running at the same time. |
| `README.md` | EDSDK setup and switching. |
| `tests/helpers/fakeEdsdk.ts` | `FakeEds` and `fakeClock` for the worker tests. |
| `tests/edsdk.worker.test.ts` | `CameraWorker` tests. |
| `tests/edsdk.source.test.ts` | `EdsdkSource` tests with a fake worker handle. |
| `tests/edsdk.config.test.ts` | Schema defaults and preflight EDSDK checks. |

---

### Task 0: Revert PR #46 (phase 0)

This is its own branch and PR, separate from `feat/edsdk-camera`.

**Files:**
- Modify (by revert): `src/camera/CanonTetheredSource.ts`
- Delete (by revert): `tests/canon.afFallback.test.ts`

- [ ] **Step 1: Branch from master and revert the merge**

```bash
cd C:/Users/User/Documents/booth-agent
git checkout master && git pull --ff-only
git checkout -b revert/canon-af-fallback
git revert -m 1 0fb00ca --no-edit
```

Expected: a commit reading `Revert "Merge pull request #46 ..."`. Then amend its message so it explains why, keeping the attribution line:

```bash
git commit --amend -F - <<'EOF'
revert: drop the CaptureNoAf fallback from #46

Live testing on 2026-09-25 showed it can never work: after a single 8D01
the R100 answers 0x81 (busy) to every command until it is power-cycled,
because digiCamControl never releases the shutter button after a failed
capture. The fallback only added a 10 s timeout before the same failure.
The real fix is the EDSDK camera worker
(docs/superpowers/specs/2026-09-25-edsdk-camera-design.md).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 2: Verify**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: typecheck clean, and all tests pass (202, because the 3 AF-fallback tests are gone).

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin revert/canon-af-fallback
gh pr create --base master --title "revert: drop the CaptureNoAf fallback from #46" --body "<why + testing, end with the Claude Code line>"
```

- [ ] **Step 4: Merge and deploy only when the user says so**

After CI passes and the user says to merge:
1. `gh pr merge <n> --merge`
2. `git checkout master && git pull --ff-only && npm run build`
3. Ask the user to run `Restart-Service boothagent` in an admin shell.
4. Confirm that `GET /health/preflight` `ranAt` changed.
5. Merge master into `feat/edsdk-camera`: `git checkout feat/edsdk-camera && git merge master`.

---

### Task 1: EdsApi, the fake EDSDK, and CameraWorker connection handling

**Files:**
- Create: `src/camera/edsdk/edsdkApi.ts`
- Create: `src/camera/edsdk/protocol.ts`
- Create: `src/camera/edsdk/CameraWorker.ts`
- Create: `tests/helpers/fakeEdsdk.ts`
- Test: `tests/edsdk.worker.test.ts`

**Interfaces:**
- Produces:
  - `EdsApi`, `EdsRef`, `DirItem`, `EDS`, `DISCONNECT_ERRORS`, `hex` (from `edsdkApi.ts`)
  - `RequestBody`, `WorkerRequest`, `WorkerResponse`, `WorkerEvent`, `WorkerMessage`, `LogLevel`, `isResponse` (from `protocol.ts`)
  - `Clock`, `realClock`, `CameraWorker` (from `CameraWorker.ts`), with:
    - `constructor(eds: EdsApi, emit: (e: WorkerEvent) => void, clock?: Clock)`
    - `start(): void`
    - `tick(): void`
    - `get connected(): boolean`
- Task 2 adds `capture`; Task 3 adds `frame` and `shutdown`.

- [ ] **Step 1: Create `src/camera/edsdk/edsdkApi.ts`**

```ts
/**
 * The slice of Canon's EDSDK the camera worker uses, as an interface so the
 * worker's logic can be tested against a fake. The real implementation
 * (koffi + EDSDK.dll) lives in edsdkNative.ts and is only loaded inside the
 * worker process. Every method returns the raw EdsError code (0 = OK)
 * rather than throwing, because the error code IS the information
 * (8D01 vs 81 vs a disconnect all need different handling).
 */

/** Opaque EDSDK object reference: a native pointer under koffi, anything in tests. */
export type EdsRef = unknown;

export const EDS = {
  ERR_OK: 0x0,
  ERR_DEVICE_NOT_FOUND: 0x80,
  ERR_DEVICE_BUSY: 0x81,
  ERR_COMM_PORT_IS_IN_USE: 0xc0,
  ERR_COMM_DISCONNECTED: 0xc1,
  ERR_COMM_USB_BUS_ERR: 0xc4,
  ERR_SESSION_NOT_OPEN: 0x2003,
  ERR_TAKE_PICTURE_AF_NG: 0x8d01,
  ERR_OBJECT_NOTREADY: 0xa102,

  PROP_SAVE_TO: 0x0b,
  PROP_EVF_OUTPUT_DEVICE: 0x500,
  SAVE_TO_HOST: 2,
  EVF_OUTPUT_PC: 2,

  CMD_EXTEND_SHUTDOWN_TIMER: 0x01,
  CMD_PRESS_SHUTTER_BUTTON: 0x04,
  SHUTTER_OFF: 0,
  SHUTTER_COMPLETELY: 3,
  SHUTTER_COMPLETELY_NON_AF: 0x10003,

  OBJECT_EVENT_DIR_ITEM_REQUEST_TRANSFER: 0x208,
  STATE_EVENT_SHUTDOWN: 0x301,
} as const;

/** Errors that mean the camera is gone: close the session and go back to scanning. */
export const DISCONNECT_ERRORS: ReadonlySet<number> = new Set([
  EDS.ERR_DEVICE_NOT_FOUND,
  EDS.ERR_COMM_PORT_IS_IN_USE,
  EDS.ERR_COMM_DISCONNECTED,
  EDS.ERR_COMM_USB_BUS_ERR,
  EDS.ERR_SESSION_NOT_OPEN,
]);

export const hex = (code: number): string => `0x${(code >>> 0).toString(16).toUpperCase()}`;

export interface DirItem {
  size: bigint;
  fileName: string;
}

export interface EdsApi {
  initialize(): number;
  terminate(): number;
  /** The first connected camera, or null. The caller owns the returned ref and must release it. */
  firstCamera(): { ref: EdsRef; description: string } | null;
  openSession(cam: EdsRef): number;
  closeSession(cam: EdsRef): number;
  release(ref: EdsRef): void;
  getU32(cam: EdsRef, prop: number): { err: number; value: number };
  setU32(cam: EdsRef, prop: number, value: number): number;
  /** Tells the camera the host has room for the photo; required with SaveTo = Host. */
  setCapacityHost(cam: EdsRef): number;
  sendCommand(cam: EdsRef, command: number, param: number): number;
  /** Handlers run synchronously inside getEvent(). The object handler must not release the ref - the caller does. */
  setObjectHandler(cam: EdsRef, handler: (event: number, ref: EdsRef) => void): number;
  setStateHandler(cam: EdsRef, handler: (event: number) => void): number;
  /** Pumps EDSDK's event queue; handlers fire from inside this call. */
  getEvent(): void;
  downloadEvfFrame(cam: EdsRef): { err: number; jpeg: Buffer | null };
  dirItem(item: EdsRef): { err: number; item: DirItem | null };
  /** Downloads the whole item to filePath and marks the transfer complete. */
  downloadToFile(item: EdsRef, size: bigint, filePath: string): number;
  downloadCancel(item: EdsRef): number;
}
```

- [ ] **Step 2: Create `src/camera/edsdk/protocol.ts`**

```ts
/** Messages between EdsdkSource (agent side) and the camera worker child process. */

export type RequestBody =
  | { type: "capture"; destPath: string }
  | { type: "frame" }
  | { type: "ping" }
  | { type: "shutdown" };

export type WorkerRequest = RequestBody & { id: number };

/** `result` is a JPEG for "frame" (or null when there is none right now) and null for everything else. */
export type WorkerResponse =
  | { id: number; ok: true; result: Uint8Array | null }
  | { id: number; ok: false; error: string };

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Pushed by the worker on its own, not in answer to a request. */
export type WorkerEvent =
  | { type: "state"; connected: boolean; model: string | null }
  | { type: "log"; level: LogLevel; message: string };

export type WorkerMessage = WorkerResponse | WorkerEvent;

export const isResponse = (m: WorkerMessage): m is WorkerResponse => "id" in m;
```

- [ ] **Step 3: Create `tests/helpers/fakeEdsdk.ts`**

```ts
import { writeFileSync } from "node:fs";
import { DirItem, EDS, EdsApi, EdsRef } from "../../src/camera/edsdk/edsdkApi";

/**
 * A scriptable stand-in for EDSDK. The camera ref is the string "cam"; a
 * directory item ref is its file name. Events queued by sendCommand/unplug are
 * delivered on the next getEvent(), which is how the real SDK behaves.
 */
export class FakeEds implements EdsApi {
  /** What firstCamera() finds: a model name, or null for "nothing plugged in". */
  camera: string | null = "Canon EOS R100";
  /** Results for successive (non-OFF) shutter presses; once empty, presses succeed. */
  pressResults: number[] = [];
  /** Files a successful full press sends to the host, in order. */
  photoNames: string[] = ["IMG_0001.JPG"];
  evfFrame: { err: number; jpeg: Buffer | null } = { err: 0, jpeg: Buffer.from("frame") };
  evfOutput = 1; // TFT only, as the camera starts
  props = new Map<number, number>();
  commands: Array<{ command: number; param: number }> = [];
  calls: string[] = [];
  downloads: Array<{ name: string; path: string }> = [];
  cancels: string[] = [];
  sessionOpen = false;
  private objectHandler: ((event: number, ref: EdsRef) => void) | null = null;
  private stateHandler: ((event: number) => void) | null = null;
  private queued: Array<() => void> = [];

  initialize(): number { this.calls.push("initialize"); return 0; }
  terminate(): number { this.calls.push("terminate"); return 0; }
  firstCamera(): { ref: EdsRef; description: string } | null {
    this.calls.push("firstCamera");
    return this.camera ? { ref: "cam", description: this.camera } : null;
  }
  openSession(): number { this.sessionOpen = true; this.calls.push("openSession"); return 0; }
  closeSession(): number { this.sessionOpen = false; this.calls.push("closeSession"); return 0; }
  release(): void {}
  getU32(_cam: EdsRef, prop: number): { err: number; value: number } {
    return { err: 0, value: prop === EDS.PROP_EVF_OUTPUT_DEVICE ? this.evfOutput : this.props.get(prop) ?? 0 };
  }
  setU32(_cam: EdsRef, prop: number, value: number): number {
    if (prop === EDS.PROP_EVF_OUTPUT_DEVICE) this.evfOutput = value;
    else this.props.set(prop, value);
    return 0;
  }
  setCapacityHost(): number { return 0; }
  sendCommand(_cam: EdsRef, command: number, param: number): number {
    this.commands.push({ command, param });
    if (command !== EDS.CMD_PRESS_SHUTTER_BUTTON || param === EDS.SHUTTER_OFF) return 0;
    const err = this.pressResults.shift() ?? 0;
    if (err === 0) {
      for (const name of this.photoNames) {
        this.queued.push(() => this.objectHandler?.(EDS.OBJECT_EVENT_DIR_ITEM_REQUEST_TRANSFER, name));
      }
    }
    return err;
  }
  setObjectHandler(_cam: EdsRef, handler: (event: number, ref: EdsRef) => void): number {
    this.objectHandler = handler;
    return 0;
  }
  setStateHandler(_cam: EdsRef, handler: (event: number) => void): number {
    this.stateHandler = handler;
    return 0;
  }
  getEvent(): void {
    const due = this.queued;
    this.queued = [];
    for (const fire of due) fire();
  }
  downloadEvfFrame(): { err: number; jpeg: Buffer | null } { return this.evfFrame; }
  dirItem(item: EdsRef): { err: number; item: DirItem | null } {
    return { err: 0, item: { size: 3n, fileName: String(item) } };
  }
  downloadToFile(item: EdsRef, _size: bigint, filePath: string): number {
    writeFileSync(filePath, "jpg");
    this.downloads.push({ name: String(item), path: filePath });
    return 0;
  }
  downloadCancel(item: EdsRef): number { this.cancels.push(String(item)); return 0; }

  /** Like pulling the USB cable: the camera vanishes and a Shutdown state event arrives on the next getEvent(). */
  unplug(): void {
    this.camera = null;
    this.queued.push(() => this.stateHandler?.(EDS.STATE_EVENT_SHUTDOWN));
  }

  /** Every PressShutterButton param sent, in order, OFF (0) included. */
  get presses(): number[] {
    return this.commands.filter((c) => c.command === EDS.CMD_PRESS_SHUTTER_BUTTON).map((c) => c.param);
  }
}

/** A clock whose sleep() just moves time forward, so timeouts run instantly in tests. */
export function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}
```

- [ ] **Step 4: Write the failing connection tests in `tests/edsdk.worker.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { CameraWorker } from "../src/camera/edsdk/CameraWorker";
import { EDS } from "../src/camera/edsdk/edsdkApi";
import { WorkerEvent } from "../src/camera/edsdk/protocol";
import { FakeEds, fakeClock } from "./helpers/fakeEdsdk";

let eds: FakeEds;
let clock: ReturnType<typeof fakeClock>;
let events: WorkerEvent[];
let worker: CameraWorker;

function makeWorker() {
  eds = new FakeEds();
  clock = fakeClock(1_000_000);
  events = [];
  worker = new CameraWorker(eds, (e) => events.push(e), clock);
  worker.start();
}

const states = () => events.filter((e) => e.type === "state");

describe("CameraWorker connection", () => {
  beforeEach(makeWorker);

  it("connects on the first tick and puts the camera in host-save mode", () => {
    worker.tick();
    expect(worker.connected).toBe(true);
    expect(states()).toEqual([{ type: "state", connected: true, model: "Canon EOS R100" }]);
    expect(eds.props.get(EDS.PROP_SAVE_TO)).toBe(EDS.SAVE_TO_HOST);
  });

  it("scans once a second while no camera is plugged in", () => {
    eds.camera = null;
    worker.tick();
    clock.advance(500);
    worker.tick();
    clock.advance(500);
    worker.tick();
    expect(eds.calls.filter((c) => c === "firstCamera")).toHaveLength(2);
    expect(worker.connected).toBe(false);
  });

  it("re-initializes EDSDK after 5 empty scans in case its camera list went stale", () => {
    eds.camera = null;
    for (let i = 0; i < 5; i++) {
      worker.tick();
      clock.advance(1000);
    }
    expect(eds.calls.filter((c) => c === "terminate")).toHaveLength(1);
    expect(eds.calls.filter((c) => c === "initialize")).toHaveLength(2); // start() + re-init
  });

  it("drops the session on a camera shutdown and reconnects when it comes back", () => {
    worker.tick();
    eds.unplug();
    worker.tick();
    expect(worker.connected).toBe(false);
    expect(eds.sessionOpen).toBe(false);
    expect(states().at(-1)).toEqual({ type: "state", connected: false, model: null });

    eds.camera = "Canon EOS R100";
    clock.advance(1000);
    worker.tick();
    expect(worker.connected).toBe(true);
    expect(states().at(-1)).toMatchObject({ connected: true });
  });

  it("keeps the camera awake every 60 s", () => {
    worker.tick();
    const keepAwakes = () => eds.commands.filter((c) => c.command === EDS.CMD_EXTEND_SHUTDOWN_TIMER).length;
    clock.advance(59_000);
    worker.tick();
    expect(keepAwakes()).toBe(0);
    clock.advance(1_000);
    worker.tick();
    expect(keepAwakes()).toBe(1);
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx vitest run tests/edsdk.worker.test.ts`
Expected: FAIL, "Cannot find module '../src/camera/edsdk/CameraWorker'".

- [ ] **Step 6: Create `src/camera/edsdk/CameraWorker.ts` (connection part)**

```ts
import { DISCONNECT_ERRORS, EDS, EdsApi, EdsRef, hex } from "./edsdkApi";
import { LogLevel, WorkerEvent } from "./protocol";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const SCAN_INTERVAL_MS = 1_000;
// EdsGetCameraList in a long-lived process may not notice a re-plugged
// camera; re-initializing the SDK now and then forces a fresh device list.
const REINIT_AFTER_EMPTY_SCANS = 5;
const KEEP_AWAKE_MS = 60_000;

/**
 * Everything the camera worker process does with the Canon, written against
 * EdsApi so it can be tested without a camera. Runs on the worker's single
 * thread: tick() is called every ~30 ms by worker.ts, and every EDSDK call
 * (including the event handlers, which fire inside getEvent()) happens there.
 */
export class CameraWorker {
  private cam: EdsRef | null = null;
  private lastScanAt = Number.NEGATIVE_INFINITY;
  private emptyScans = 0;
  private lastKeepAwakeAt = 0;
  /** Set by the state handler; acted on after getEvent() returns, never re-entrantly inside it. */
  private shutdownSeen = false;

  constructor(
    private readonly eds: EdsApi,
    private readonly emit: (event: WorkerEvent) => void,
    private readonly clock: Clock = realClock
  ) {}

  get connected(): boolean {
    return this.cam !== null;
  }

  start(): void {
    const err = this.eds.initialize();
    if (err !== EDS.ERR_OK) throw new Error(`EdsInitializeSDK failed: ${hex(err)}`);
  }

  tick(): void {
    this.pumpEvents();
    const now = this.clock.now();
    if (!this.cam) {
      if (now - this.lastScanAt >= SCAN_INTERVAL_MS) {
        this.lastScanAt = now;
        this.scan();
      }
      return;
    }
    if (now - this.lastKeepAwakeAt >= KEEP_AWAKE_MS) {
      this.lastKeepAwakeAt = now;
      this.check(this.eds.sendCommand(this.cam, EDS.CMD_EXTEND_SHUTDOWN_TIMER, 0), "keep-awake");
    }
  }

  private pumpEvents(): void {
    this.eds.getEvent();
    if (this.shutdownSeen) {
      this.shutdownSeen = false;
      this.disconnect("camera shut down");
    }
  }

  private scan(): void {
    const found = this.eds.firstCamera();
    if (!found) {
      this.emptyScans += 1;
      if (this.emptyScans >= REINIT_AFTER_EMPTY_SCANS) {
        this.emptyScans = 0;
        this.eds.terminate();
        this.eds.initialize();
      }
      return;
    }
    this.emptyScans = 0;
    const cam = found.ref;
    const err = this.eds.openSession(cam);
    if (err !== EDS.ERR_OK) {
      this.log("warn", `Opening a session with ${found.description} failed: ${hex(err)}`);
      this.eds.release(cam);
      return;
    }
    this.cam = cam;
    this.shutdownSeen = false;
    this.eds.setObjectHandler(cam, (event, ref) => this.onObject(event, ref));
    this.eds.setStateHandler(cam, (event) => {
      if (event === EDS.STATE_EVENT_SHUTDOWN) this.shutdownSeen = true;
    });
    // Photos come straight to the PC; nothing is written to the card.
    if (this.check(this.eds.setU32(cam, EDS.PROP_SAVE_TO, EDS.SAVE_TO_HOST), "set SaveTo=Host") !== EDS.ERR_OK) return;
    if (this.check(this.eds.setCapacityHost(cam), "set host capacity") !== EDS.ERR_OK) return;
    this.lastKeepAwakeAt = this.clock.now();
    this.log("info", `Connected to ${found.description}`);
    this.emit({ type: "state", connected: true, model: found.description });
  }

  /** Placeholder until Task 2 handles photo transfers. */
  private onObject(_event: number, _ref: EdsRef): void {}

  /** Logs a failed call and drops the session when the error means the camera is gone. Returns err unchanged. */
  private check(err: number, what: string): number {
    if (err === EDS.ERR_OK) return err;
    this.log("warn", `${what} failed: ${hex(err)}`);
    if (DISCONNECT_ERRORS.has(err)) this.disconnect(`${what} returned ${hex(err)}`);
    return err;
  }

  private disconnect(reason: string): void {
    const cam = this.cam;
    if (!cam) return;
    this.cam = null;
    this.eds.closeSession(cam);
    this.eds.release(cam);
    this.lastScanAt = this.clock.now();
    this.log("warn", `Camera disconnected (${reason})`);
    this.emit({ type: "state", connected: false, model: null });
  }

  private log(level: LogLevel, message: string): void {
    this.emit({ type: "log", level, message });
  }
}
```

Note: the `onObject` stub is replaced in Task 2 Step 3. It is the only temporary code in this plan, and it exists because the handler must be registered at connect time.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/edsdk.worker.test.ts`
Expected: 5 passed.

- [ ] **Step 8: Typecheck and commit**

```bash
npx tsc -p tsconfig.json --noEmit
git add src/camera/edsdk tests/helpers/fakeEdsdk.ts tests/edsdk.worker.test.ts
git commit -m "feat(edsdk): camera worker connection, reconnect and keep-awake" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: CameraWorker capture with AF recovery

**Files:**
- Modify: `src/camera/edsdk/CameraWorker.ts`
- Test: `tests/edsdk.worker.test.ts`

**Interfaces:**
- Consumes: `CameraWorker`, `FakeEds`, `fakeClock` (Task 1)
- Produces: `CameraWorker.capture(destPath: string): Promise<void>`. It resolves once the JPEG is on disk at `destPath` and rejects with an `Error` otherwise.

- [ ] **Step 1: Add the failing capture tests (append to `tests/edsdk.worker.test.ts`)**

```ts
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dest = () => path.join(mkdtempSync(path.join(tmpdir(), "edsdk-")), "canon-x.jpg");

describe("CameraWorker capture", () => {
  beforeEach(() => {
    makeWorker();
    worker.tick(); // connected
  });

  it("presses fully, always releases, and downloads the JPEG to destPath", async () => {
    const file = dest();
    await worker.capture(file);
    expect(eds.presses).toEqual([EDS.SHUTTER_COMPLETELY, EDS.SHUTTER_OFF]);
    expect(existsSync(file)).toBe(true);
  });

  it("on autofocus failure (8D01) releases, then takes the shot without autofocus", async () => {
    eds.pressResults = [EDS.ERR_TAKE_PICTURE_AF_NG];
    await worker.capture(dest());
    expect(eds.presses).toEqual([
      EDS.SHUTTER_COMPLETELY, EDS.SHUTTER_OFF,
      EDS.SHUTTER_COMPLETELY_NON_AF, EDS.SHUTTER_OFF,
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "log", level: "warn" }));
  });

  it("on busy (81) releases, waits 500 ms and retries once", async () => {
    eds.pressResults = [EDS.ERR_DEVICE_BUSY];
    const before = clock.now();
    await worker.capture(dest());
    expect(eds.presses).toEqual([EDS.SHUTTER_COMPLETELY, EDS.SHUTTER_OFF, EDS.SHUTTER_COMPLETELY, EDS.SHUTTER_OFF]);
    expect(clock.now() - before).toBeGreaterThanOrEqual(500);
  });

  it("fails on any other shutter error, still releasing the button", async () => {
    eds.pressResults = [0x2a];
    await expect(worker.capture(dest())).rejects.toThrow("0x2A");
    expect(eds.presses).toEqual([EDS.SHUTTER_COMPLETELY, EDS.SHUTTER_OFF]);
  });

  it("cancels a non-JPEG transfer and keeps the JPEG", async () => {
    eds.photoNames = ["IMG_0001.CR3", "IMG_0001.JPG"];
    const file = dest();
    await worker.capture(file);
    expect(eds.cancels).toEqual(["IMG_0001.CR3"]);
    expect(eds.downloads).toEqual([{ name: "IMG_0001.JPG", path: file }]);
  });

  it("times out after 10 s with no photo", async () => {
    eds.photoNames = [];
    await expect(worker.capture(dest())).rejects.toThrow("timed out");
  });

  it("fails fast when the camera is unplugged mid-capture", async () => {
    eds.photoNames = [];
    eds.unplug();
    await expect(worker.capture(dest())).rejects.toThrow("disconnected");
    expect(worker.connected).toBe(false);
  });

  it("refuses to capture with no camera", async () => {
    eds.unplug();
    worker.tick();
    await expect(worker.capture(dest())).rejects.toThrow("No Canon camera connected");
  });
});
```

Move the `node:fs`/`node:os`/`node:path` imports to the top of the file along with the existing imports.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/edsdk.worker.test.ts`
Expected: the 8 new tests FAIL with "worker.capture is not a function"; the 5 connection tests still pass.

- [ ] **Step 3: Implement capture in `CameraWorker.ts`**

Add these constants after `KEEP_AWAKE_MS`:

```ts
const BUSY_RETRY_DELAY_MS = 500;
const TRANSFER_TIMEOUT_MS = 10_000;
const EVENT_POLL_MS = 30;
```

Add these fields to the class:

```ts
  private capturing = false;
  /** The capture waiting for its photo; the object handler downloads into it. */
  private pendingTransfer: { destPath: string; done: boolean; err: number } | null = null;
```

Replace the `onObject` placeholder with:

```ts
  private onObject(event: number, ref: EdsRef): void {
    try {
      if (event !== EDS.OBJECT_EVENT_DIR_ITEM_REQUEST_TRANSFER) return;
      const transfer = this.pendingTransfer;
      const { err, item } = this.eds.dirItem(ref);
      if (!transfer || transfer.done || err !== EDS.ERR_OK || !item || !/\.jpe?g$/i.test(item.fileName)) {
        // Nobody is waiting, or it's the RAW half of RAW+JPEG: let the camera move on.
        this.eds.downloadCancel(ref);
        this.log("info", `Skipped transfer of ${item?.fileName ?? "an unreadable item"}`);
        return;
      }
      transfer.err = this.eds.downloadToFile(ref, item.size, transfer.destPath);
      transfer.done = true;
    } finally {
      this.eds.release(ref);
    }
  }
```

Add the public `capture` and the private `press`:

```ts
  async capture(destPath: string): Promise<void> {
    if (!this.cam) throw new Error("No Canon camera connected");
    const transfer = { destPath, done: false, err: EDS.ERR_OK as number };
    this.capturing = true;
    this.pendingTransfer = transfer;
    try {
      let err = await this.press(EDS.SHUTTER_COMPLETELY);
      if (err === EDS.ERR_TAKE_PICTURE_AF_NG) {
        this.log("warn", "Autofocus failed (8D01) - taking this shot without autofocus");
        err = await this.press(EDS.SHUTTER_COMPLETELY_NON_AF);
      }
      if (err !== EDS.ERR_OK) {
        this.check(err, "shutter");
        throw new Error(`Canon shutter failed: ${hex(err)}`);
      }
      const start = this.clock.now();
      while (!transfer.done) {
        if (!this.cam) throw new Error("Camera disconnected during capture");
        if (this.clock.now() - start >= TRANSFER_TIMEOUT_MS) {
          throw new Error("Canon capture timed out waiting for the photo");
        }
        this.pumpEvents();
        if (!transfer.done) await this.clock.sleep(EVENT_POLL_MS);
      }
      if (transfer.err !== EDS.ERR_OK) throw new Error(`Canon photo download failed: ${hex(transfer.err)}`);
    } finally {
      this.pendingTransfer = null;
      this.capturing = false;
    }
  }

  /**
   * One shutter press, ALWAYS followed by a release. digiCamControl skips the
   * release when the press fails, which leaves the R100 answering 0x81 (busy)
   * to everything until it is power-cycled - the bug this worker exists to fix.
   */
  private async press(param: number): Promise<number> {
    const once = (cam: EdsRef): number => {
      const err = this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, param);
      this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_OFF);
      return err;
    };
    const cam = this.cam;
    if (!cam) return EDS.ERR_DEVICE_NOT_FOUND;
    const err = once(cam);
    if (err !== EDS.ERR_DEVICE_BUSY) return err;
    await this.clock.sleep(BUSY_RETRY_DELAY_MS);
    return this.cam ? once(this.cam) : EDS.ERR_DEVICE_NOT_FOUND;
  }
```

Why the loop pumps before it sleeps: with the fake clock, `sleep` resolves at once. Pumping first means the transfer queued by the press is delivered on the first pass, and the unplug test sees `!this.cam` on the second pass.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/edsdk.worker.test.ts`
Expected: 13 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc -p tsconfig.json --noEmit
git add src/camera/edsdk/CameraWorker.ts tests/edsdk.worker.test.ts
git commit -m "feat(edsdk): capture with guaranteed shutter release and AF/busy recovery" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: CameraWorker live view and shutdown

**Files:**
- Modify: `src/camera/edsdk/CameraWorker.ts`
- Test: `tests/edsdk.worker.test.ts`

**Interfaces:**
- Consumes: `CameraWorker` (Tasks 1-2)
- Produces:
  - `CameraWorker.frame(): Buffer | null`
  - `CameraWorker.shutdown(): void`

- [ ] **Step 1: Add the failing tests (append to `tests/edsdk.worker.test.ts`)**

```ts
describe("CameraWorker live view", () => {
  beforeEach(() => {
    makeWorker();
    worker.tick();
  });

  it("turns live view on at the first frame request and returns the frame", () => {
    expect(worker.frame()).toEqual(Buffer.from("frame"));
    expect(eds.evfOutput & EDS.EVF_OUTPUT_PC).toBe(EDS.EVF_OUTPUT_PC);
    expect(eds.evfOutput & 1).toBe(1); // the camera's own screen bit is left alone
  });

  it("returns null while the camera has no frame ready yet", () => {
    eds.evfFrame = { err: EDS.ERR_OBJECT_NOTREADY, jpeg: null };
    expect(worker.frame()).toBeNull();
  });

  it("turns live view off after 10 s without a frame request, and back on when asked", () => {
    worker.frame();
    clock.advance(9_999);
    worker.tick();
    expect(eds.evfOutput & EDS.EVF_OUTPUT_PC).toBe(EDS.EVF_OUTPUT_PC);
    clock.advance(1);
    worker.tick();
    expect(eds.evfOutput & EDS.EVF_OUTPUT_PC).toBe(0);
    worker.frame();
    expect(eds.evfOutput & EDS.EVF_OUTPUT_PC).toBe(EDS.EVF_OUTPUT_PC);
  });

  it("returns null during a capture instead of queueing behind it", async () => {
    eds.photoNames = [];
    const capture = worker.capture(dest());
    expect(worker.frame()).toBeNull();
    await expect(capture).rejects.toThrow("timed out");
  });

  it("returns null with no camera", () => {
    eds.unplug();
    worker.tick();
    expect(worker.frame()).toBeNull();
  });
});

describe("CameraWorker shutdown", () => {
  it("releases the shutter, stops live view, closes the session and terminates EDSDK", () => {
    makeWorker();
    worker.tick();
    worker.frame();
    worker.shutdown();
    expect(eds.presses.at(-1)).toBe(EDS.SHUTTER_OFF);
    expect(eds.evfOutput & EDS.EVF_OUTPUT_PC).toBe(0);
    expect(eds.sessionOpen).toBe(false);
    expect(eds.calls.at(-1)).toBe("terminate");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/edsdk.worker.test.ts`
Expected: the 6 new tests FAIL, "worker.frame is not a function".

- [ ] **Step 3: Implement live view and shutdown**

Add this constant:

```ts
const LIVEVIEW_IDLE_MS = 10_000;
```

Add these fields:

```ts
  private liveviewOn = false;
  private lastFrameAt = 0;
```

In `tick()`, after the keep-awake block, still inside the connected branch, add:

```ts
    if (this.liveviewOn && !this.capturing && now - this.lastFrameAt >= LIVEVIEW_IDLE_MS) {
      this.setLiveview(false);
    }
```

In `disconnect()`, after `this.cam = null;`, add:

```ts
    this.liveviewOn = false;
```

Add these methods:

```ts
  /** The latest live-view JPEG, or null (no camera, mid-capture, or no frame ready yet). */
  frame(): Buffer | null {
    if (!this.cam || this.capturing) return null;
    this.lastFrameAt = this.clock.now();
    if (!this.liveviewOn && !this.setLiveview(true)) return null;
    const { err, jpeg } = this.eds.downloadEvfFrame(this.cam);
    if (err === EDS.ERR_OBJECT_NOTREADY) return null;
    if (this.check(err, "live view frame") !== EDS.ERR_OK) return null;
    return jpeg;
  }

  /** Flips only the PC bit of Evf_OutputDevice, leaving the camera's own screen as it was. */
  private setLiveview(on: boolean): boolean {
    const cam = this.cam;
    if (!cam) return false;
    const current = this.eds.getU32(cam, EDS.PROP_EVF_OUTPUT_DEVICE);
    if (this.check(current.err, "read live view output") !== EDS.ERR_OK) return false;
    const next = on ? current.value | EDS.EVF_OUTPUT_PC : current.value & ~EDS.EVF_OUTPUT_PC;
    if (this.check(this.eds.setU32(cam, EDS.PROP_EVF_OUTPUT_DEVICE, next >>> 0), "set live view output") !== EDS.ERR_OK) {
      return false;
    }
    this.liveviewOn = on;
    return true;
  }

  shutdown(): void {
    const cam = this.cam;
    if (cam) {
      this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_OFF);
      if (this.liveviewOn) this.setLiveview(false);
      this.eds.closeSession(cam);
      this.eds.release(cam);
      this.cam = null;
    }
    this.eds.terminate();
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/edsdk.worker.test.ts`
Expected: 19 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc -p tsconfig.json --noEmit
git add src/camera/edsdk/CameraWorker.ts tests/edsdk.worker.test.ts
git commit -m "feat(edsdk): on-demand live view with idle shutoff, clean shutdown" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: EdsdkSource (agent side: requests, timeouts, supervision)

**Files:**
- Create: `src/camera/edsdk/EdsdkSource.ts`
- Test: `tests/edsdk.source.test.ts`

**Interfaces:**
- Consumes: `RequestBody`, `WorkerMessage`, `WorkerRequest`, `isResponse` (Task 1); `CameraSource` and `CaptureResult` (`src/camera/CameraSource.ts`)
- Produces:
  - `WorkerHandle` interface
  - `spawnWorker(dllPath: string): WorkerHandle` (forks `worker.js` next to the compiled file; the worker is created in Task 5)
  - `class EdsdkSource implements CameraSource`, with `constructor(spawn: () => WorkerHandle)`

- [ ] **Step 1: Write the failing tests in `tests/edsdk.source.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { EdsdkSource, WorkerHandle } from "../src/camera/edsdk/EdsdkSource";
import { WorkerMessage, WorkerRequest } from "../src/camera/edsdk/protocol";

/** In-process stand-in for the worker child process. `reply` decides how each request is answered. */
class FakeWorker extends EventEmitter implements WorkerHandle {
  sent: WorkerRequest[] = [];
  killed = false;
  reply: (req: WorkerRequest) => WorkerMessage | Promise<WorkerMessage> | null = (req) => ({ id: req.id, ok: true, result: null });

  send(req: WorkerRequest): boolean {
    this.sent.push(req);
    void Promise.resolve(this.reply(req)).then((m) => m && this.emit("message", m));
    return true;
  }
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null));
    return true;
  }
  push(m: WorkerMessage): void {
    this.emit("message", m);
  }
}

let workers: FakeWorker[];
let source: EdsdkSource;
const current = () => workers.at(-1)!;

beforeEach(async () => {
  vi.useFakeTimers();
  workers = [];
  source = new EdsdkSource(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  await source.initialize();
});

afterEach(async () => {
  current().reply = (req) => {
    if (req.type === "shutdown") queueMicrotask(() => current().emit("exit", 0));
    return { id: req.id, ok: true, result: null };
  };
  await source.shutdown();
  vi.useRealTimers();
});

describe("EdsdkSource", () => {
  it("is healthy only once the worker reports a connected camera", async () => {
    expect(await source.isHealthy()).toBe(false);
    current().push({ type: "state", connected: true, model: "Canon EOS R100" });
    expect(await source.isHealthy()).toBe(true);
    expect(source.getModel()).toBe("Canon EOS R100");
  });

  it("returns live view frames as Buffers, and null when the request times out", async () => {
    current().push({ type: "state", connected: true, model: "Canon EOS R100" });
    current().reply = (req) => ({ id: req.id, ok: true, result: new Uint8Array([0xff, 0xd8]) });
    const frame = await source.getLiveviewFrame();
    expect(Buffer.isBuffer(frame)).toBe(true);
    expect(frame).toEqual(Buffer.from([0xff, 0xd8]));

    current().reply = () => null; // never answers
    const pending = source.getLiveviewFrame();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBeNull();
  });

  it("captures to canon-<uuid>.jpg in destDir and reports its size", async () => {
    vi.useRealTimers(); // sharp does real I/O
    current().push({ type: "state", connected: true, model: "Canon EOS R100" });
    current().reply = async (req) => {
      if (req.type === "capture") {
        await sharp({ create: { width: 30, height: 20, channels: 3, background: "#888" } }).jpeg().toFile(req.destPath);
      }
      return { id: req.id, ok: true, result: null };
    };
    const dir = mkdtempSync(path.join(tmpdir(), "edsdk-src-"));
    const result = await source.capture(dir);
    expect(path.dirname(result.filePath)).toBe(dir);
    expect(path.basename(result.filePath)).toMatch(/^canon-.+\.jpg$/);
    expect(result).toMatchObject({ width: 30, height: 20 });
    vi.useFakeTimers();
  });

  it("passes the worker's capture error through", async () => {
    current().reply = (req) => ({ id: req.id, ok: false, error: "Canon shutter failed: 0x2A" });
    await expect(source.capture(mkdtempSync(path.join(tmpdir(), "edsdk-src-")))).rejects.toThrow("0x2A");
  });

  it("respawns a crashed worker with 1 s, 2 s, 5 s, 5 s backoff", async () => {
    for (const delay of [1_000, 2_000, 5_000, 5_000]) {
      const before = workers.length;
      current().emit("exit", 1);
      expect(await source.isHealthy()).toBe(false);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(workers.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(workers.length).toBe(before + 1);
    }
  });

  it("resets the backoff once a respawned worker connects", async () => {
    current().emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    current().push({ type: "state", connected: true, model: "Canon EOS R100" });
    current().emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(workers.length).toBe(3);
  });

  it("rejects in-flight requests when the worker dies", async () => {
    current().reply = () => null;
    const pending = source.capture(mkdtempSync(path.join(tmpdir(), "edsdk-src-")));
    const assertion = expect(pending).rejects.toThrow("exited");
    // capture() awaits a real mkdir first; wait until the request has actually reached the worker.
    await vi.waitFor(() => expect(current().sent.some((r) => r.type === "capture")).toBe(true));
    current().emit("exit", 1);
    await assertion;
  });

  it("kills a worker that misses two pings, then respawns it", async () => {
    current().reply = () => null;
    const hung = current();
    await vi.advanceTimersByTimeAsync(2_000 + 2_000); // first ping times out
    expect(hung.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000); // second ping times out
    expect(hung.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(current()).not.toBe(hung);
  });

  it("does not respawn after shutdown, and force-kills a worker that won't exit", async () => {
    current().reply = () => null;
    const stuck = current();
    const done = source.shutdown();
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(stuck.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(workers.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/edsdk.source.test.ts`
Expected: FAIL, "Cannot find module '../src/camera/edsdk/EdsdkSource'".

- [ ] **Step 3: Create `src/camera/edsdk/EdsdkSource.ts`**

```ts
import { fork } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { CameraSource, CaptureResult } from "../CameraSource";
import { isResponse, RequestBody, WorkerMessage, WorkerRequest } from "./protocol";
import { createLogger } from "../../util/logger";

const log = createLogger("camera:edsdk");

const TIMEOUT_MS = { capture: 12_000, frame: 2_000, other: 3_000 } as const;
const PING_INTERVAL_MS = 2_000;
const MAX_MISSED_PINGS = 2;
const RESPAWN_BACKOFF_MS = [1_000, 2_000, 5_000] as const;
const SHUTDOWN_GRACE_MS = 3_000;

/** The parts of ChildProcess EdsdkSource uses, so tests can hand it an in-process fake. */
export interface WorkerHandle {
  send(message: WorkerRequest): boolean;
  on(event: "message", listener: (message: WorkerMessage) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

/** Forks the compiled worker (dist/camera/edsdk/worker.js) with the DLL path as its only argument. */
export function spawnWorker(dllPath: string): WorkerHandle {
  const child = fork(path.join(__dirname, "worker.js"), [dllPath], {
    serialization: "advanced", // lets photos and frames cross as binary, not JSON
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  return child as unknown as WorkerHandle;
}

interface Pending {
  resolve: (result: Uint8Array | null) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The Canon, driven through our own EDSDK worker process instead of
 * digiCamControl. EDSDK's native code runs in the child so a crash or hang
 * there can't take down printing or sync; this class supervises it (pings,
 * respawn with backoff) and caches the connection state the worker pushes,
 * so isHealthy() is instant for CameraManager's 500 ms poll.
 */
export class EdsdkSource implements CameraSource {
  readonly kind = "canon" as const;

  private worker: WorkerHandle | null = null;
  private connected = false;
  private model: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private pingTimer: NodeJS.Timeout | undefined;
  private respawnTimer: NodeJS.Timeout | undefined;
  private missedPings = 0;
  private respawns = 0;
  private stopping = false;

  constructor(private readonly spawn: () => WorkerHandle) {}

  async initialize(): Promise<boolean> {
    this.start();
    this.pingTimer = setInterval(() => void this.ping(), PING_INTERVAL_MS);
    return this.connected;
  }

  async isHealthy(): Promise<boolean> {
    return this.worker !== null && this.connected;
  }

  getModel(): string | null {
    return this.model;
  }

  async capture(destDir: string): Promise<CaptureResult> {
    await mkdir(destDir, { recursive: true });
    const filePath = path.join(destDir, `canon-${uuidv4()}.jpg`);
    await this.request({ type: "capture", destPath: filePath }, TIMEOUT_MS.capture);
    const metadata = await sharp(filePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`Canon capture produced an unreadable image: ${filePath}`);
    }
    return { filePath, width: metadata.width, height: metadata.height };
  }

  async getLiveviewFrame(): Promise<Buffer | null> {
    if (!this.connected) return null;
    try {
      const frame = await this.request({ type: "frame" }, TIMEOUT_MS.frame);
      // Structured-clone IPC delivers a Uint8Array; the MJPEG writer wants a Buffer.
      return frame && frame.byteLength > 0 ? Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength) : null;
    } catch {
      return null;
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.respawnTimer);
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        worker.kill();
        resolve();
      }, SHUTDOWN_GRACE_MS);
      worker.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.request({ type: "shutdown" }, SHUTDOWN_GRACE_MS).catch(() => undefined);
    });
  }

  private start(): void {
    const worker = this.spawn();
    this.worker = worker;
    this.missedPings = 0;
    worker.on("message", (message) => this.onMessage(message));
    worker.on("exit", (code) => this.onExit(worker, code));
  }

  private onMessage(message: WorkerMessage): void {
    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
      return;
    }
    if (message.type === "state") {
      this.connected = message.connected;
      this.model = message.model;
      if (message.connected) this.respawns = 0;
      return;
    }
    log[message.level](message.message);
  }

  private onExit(worker: WorkerHandle, code: number | null): void {
    if (this.worker !== worker) return; // an old worker we already replaced
    this.worker = null;
    this.connected = false;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Camera worker exited (code ${String(code)})`));
      this.pending.delete(id);
    }
    if (this.stopping) return;
    const delay = RESPAWN_BACKOFF_MS[Math.min(this.respawns, RESPAWN_BACKOFF_MS.length - 1)]!;
    this.respawns += 1;
    log.warn(`Camera worker exited (code ${String(code)}), restarting in ${delay} ms`);
    this.respawnTimer = setTimeout(() => this.start(), delay);
  }

  private async ping(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    try {
      await this.request({ type: "ping" }, PING_INTERVAL_MS);
      this.missedPings = 0;
    } catch {
      this.missedPings += 1;
      if (this.missedPings >= MAX_MISSED_PINGS && this.worker === worker) {
        log.warn("Camera worker stopped answering; killing it");
        worker.kill();
      }
    }
  }

  private request(body: RequestBody, timeoutMs: number): Promise<Uint8Array | null> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Camera worker is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Camera worker timed out on ${body.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.send({ ...body, id });
    });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/edsdk.source.test.ts`
Expected: 9 passed. If the ping test is off by one interval, recount it against the constants rather than changing them: pings fire at 2 s and 4 s, and each times out 2 s later, so the second miss lands at 6 s.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc -p tsconfig.json --noEmit
git add src/camera/edsdk/EdsdkSource.ts tests/edsdk.source.test.ts
git commit -m "feat(edsdk): EdsdkSource supervises the camera worker over IPC" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Native binding, worker entry, config, wiring, preflight, README

**Files:**
- Modify: `package.json` / `package-lock.json` (add `koffi`)
- Create: `src/camera/edsdk/edsdkNative.ts`
- Create: `src/camera/edsdk/worker.ts`
- Modify: `src/config/schema.ts` (lines 20-26, the Canon block)
- Modify: `src/index.ts` (line 62)
- Modify: `src/startup/preflight.ts` (`checkCanon`, lines ~112-150)
- Modify: `README.md` (the "Canon control: why digiCamControl, not EDSDK" section and the config table)
- Test: `tests/edsdk.config.test.ts`

**Interfaces:**
- Consumes:
  - `EdsApi`, `EdsRef`, `DirItem` (Task 1)
  - `CameraWorker` (Tasks 1-3)
  - `RequestBody`, `WorkerMessage`, `WorkerRequest` (Task 1)
  - `EdsdkSource`, `spawnWorker` (Task 4)
  - `AsyncMutex` (`src/util/mutex.ts`)
- Produces:
  - `loadEdsdk(dllPath: string): EdsApi`
  - `CanonConfigSchema` (exported)
  - `checkCanon(config: BoothConfig): Promise<PreflightCheck[]>` (now exported)

- [ ] **Step 1: Add koffi**

Run: `npm install koffi@^3.3.1`
Expected: `koffi` appears under `dependencies`. `npm ls koffi` shows 3.x. Do NOT run `npm ci` in `C:\Users\User\Documents\booth-agent` while the service is running; `npm install <pkg>` only adds.

- [ ] **Step 2: Write the failing config and preflight tests in `tests/edsdk.config.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const running = vi.fn<() => Promise<boolean>>();
vi.mock("../src/camera/CanonTetheredSource", () => ({
  APP_LOG_PATH: "C:\\nowhere\\app.log",
  isDigiCamControlRunning: () => running(),
}));

import { CanonConfigSchema, BoothConfig } from "../src/config/schema";
import { checkCanon } from "../src/startup/preflight";

const baseCanon = {
  digiCamControlExePath: "C:\\x\\CameraControlRemoteCmd.exe",
  sessionDir: "C:\\x\\session",
};

describe("Canon config", () => {
  it("defaults to the digiCamControl driver and the standard EDSDK path", () => {
    const parsed = CanonConfigSchema.parse(baseCanon);
    expect(parsed.driver).toBe("digicamcontrol");
    expect(parsed.edsdkDllPath).toBe("C:\\BoothAgent\\edsdk\\EDSDK.dll");
  });

  it("accepts the edsdk driver", () => {
    expect(CanonConfigSchema.parse({ ...baseCanon, driver: "edsdk" }).driver).toBe("edsdk");
  });
});

describe("preflight with the EDSDK driver", () => {
  let dll: string;
  const config = (edsdkDllPath: string) =>
    ({
      capture: {
        sourcePreference: "canon",
        canon: CanonConfigSchema.parse({ ...baseCanon, driver: "edsdk", edsdkDllPath }),
      },
    }) as unknown as BoothConfig;

  beforeEach(() => {
    dll = path.join(mkdtempSync(path.join(tmpdir(), "edsdk-dll-")), "EDSDK.dll");
    running.mockReset();
  });

  it("passes when the DLL exists and digiCamControl is not running", async () => {
    writeFileSync(dll, "");
    running.mockResolvedValue(false);
    const checks = await checkCanon(config(dll));
    expect(checks.map((c) => [c.name, c.level])).toEqual([
      ["canon.edsdkDll", "ok"],
      ["canon.digiCamControlConflict", "ok"],
    ]);
  });

  it("fails when the DLL is missing and warns when digiCamControl would fight for the camera", async () => {
    running.mockResolvedValue(true);
    const checks = await checkCanon(config(dll));
    expect(checks.find((c) => c.name === "canon.edsdkDll")?.level).toBe("fail");
    expect(checks.find((c) => c.name === "canon.digiCamControlConflict")?.level).toBe("warn");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/edsdk.config.test.ts`
Expected: FAIL, because `CanonConfigSchema` is not exported and `checkCanon` is not exported.

- [ ] **Step 4: Update `src/config/schema.ts`**

Above the main schema, add:

```ts
/**
 * `driver` picks how the Canon is controlled: through digiCamControl
 * (CanonTetheredSource) or through our own EDSDK worker (EdsdkSource). The
 * digiCamControl fields stay required until that driver is removed.
 */
export const CanonConfigSchema = z.object({
  driver: z.enum(["digicamcontrol", "edsdk"]).default("digicamcontrol"),
  edsdkDllPath: z.string().default("C:\\BoothAgent\\edsdk\\EDSDK.dll"),
  digiCamControlExePath: z.string(),
  digiCamControlHttpPort: z.number().int().positive().default(5513),
  digiCamControlHttpHost: z.string().default("127.0.0.1"),
  sessionDir: z.string(),
  pollIntervalMs: z.number().int().positive().default(1000),
});
```

Then replace the inline `canon: z.object({ ... }),` inside `capture` with `canon: CanonConfigSchema,`.

- [ ] **Step 5: Update `checkCanon` in `src/startup/preflight.ts`**

Change `async function checkCanon` to `export async function checkCanon`. At the top of its body, right after `const level = preferred ? fail : warn;`, add:

```ts
  if (config.capture.canon.driver === "edsdk") {
    const dll = config.capture.canon.edsdkDllPath;
    results.push(
      (await exists(dll))
        ? ok("canon.edsdkDll", `EDSDK found at ${dll}`)
        : level("canon.edsdkDll", `EDSDK.dll not found at ${dll} - install Canon's 64-bit EDSDK there`)
    );
    // Only one program can hold the camera: digiCamControl would fight the worker for it.
    results.push(
      (await isDigiCamControlRunning())
        ? warn("canon.digiCamControlConflict", "CameraControl.exe is running - close it (and remove it from startup) while using the EDSDK driver")
        : ok("canon.digiCamControlConflict", "digiCamControl is not running")
    );
    return results;
  }
```

Leave the digiCamControl checks below it untouched.

- [ ] **Step 6: Run the config tests**

Run: `npx vitest run tests/edsdk.config.test.ts`
Expected: 4 passed.

- [ ] **Step 7: Create `src/camera/edsdk/edsdkNative.ts`**

```ts
import koffi from "koffi";
import { DirItem, EdsApi, EdsRef } from "./edsdkApi";

/**
 * The real EdsApi: Canon's EDSDK.dll through koffi. Only the camera worker
 * process loads this. Signatures follow EDSDK 13.x, where stream lengths,
 * download sizes and EdsDirectoryItemInfo.size are 64-bit. The DLL's
 * bitness must match Node's (64-bit Node needs the 64-bit EDSDK).
 */
export function loadEdsdk(dllPath: string): EdsApi {
  const lib = koffi.load(dllPath);

  koffi.struct("EdsDeviceInfo", {
    szPortName: koffi.array("char", 256, "String"),
    szDeviceDescription: koffi.array("char", 256, "String"),
    deviceSubType: "uint32",
    reserved: "uint32",
  });
  koffi.struct("EdsCapacity", { numberOfFreeClusters: "int32", bytesPerSector: "int32", reset: "int32" });
  koffi.struct("EdsDirectoryItemInfo", {
    size: "uint64",
    isFolder: "int32",
    groupID: "uint32",
    option: "uint32",
    szFileName: koffi.array("char", 256, "String"),
    format: "uint32",
    dateTime: "uint32",
  });
  const ObjectHandler = koffi.proto("uint32 __stdcall EdsObjectEventHandler(uint32 event, void *ref, void *ctx)");
  const StateHandler = koffi.proto("uint32 __stdcall EdsStateEventHandler(uint32 event, uint32 param, void *ctx)");

  const f = {
    initialize: lib.func("uint32 __stdcall EdsInitializeSDK()"),
    terminate: lib.func("uint32 __stdcall EdsTerminateSDK()"),
    getCameraList: lib.func("uint32 __stdcall EdsGetCameraList(_Out_ void **list)"),
    getChildCount: lib.func("uint32 __stdcall EdsGetChildCount(void *ref, _Out_ uint32 *count)"),
    getChildAtIndex: lib.func("uint32 __stdcall EdsGetChildAtIndex(void *ref, int32 index, _Out_ void **child)"),
    getDeviceInfo: lib.func("uint32 __stdcall EdsGetDeviceInfo(void *cam, _Out_ EdsDeviceInfo *info)"),
    openSession: lib.func("uint32 __stdcall EdsOpenSession(void *cam)"),
    closeSession: lib.func("uint32 __stdcall EdsCloseSession(void *cam)"),
    release: lib.func("uint32 __stdcall EdsRelease(void *ref)"),
    getU32: lib.func("uint32 __stdcall EdsGetPropertyData(void *ref, uint32 id, int32 param, uint32 size, _Out_ uint32 *data)"),
    setU32: lib.func("uint32 __stdcall EdsSetPropertyData(void *ref, uint32 id, int32 param, uint32 size, _In_ uint32 *data)"),
    setCapacity: lib.func("uint32 __stdcall EdsSetCapacity(void *cam, EdsCapacity capacity)"),
    sendCommand: lib.func("uint32 __stdcall EdsSendCommand(void *cam, uint32 command, int32 param)"),
    setObjectHandler: lib.func("uint32 __stdcall EdsSetObjectEventHandler(void *cam, uint32 event, EdsObjectEventHandler *handler, void *ctx)"),
    setStateHandler: lib.func("uint32 __stdcall EdsSetCameraStateEventHandler(void *cam, uint32 event, EdsStateEventHandler *handler, void *ctx)"),
    getEvent: lib.func("uint32 __stdcall EdsGetEvent()"),
    createMemoryStream: lib.func("uint32 __stdcall EdsCreateMemoryStream(uint64 size, _Out_ void **stream)"),
    createFileStream: lib.func("uint32 __stdcall EdsCreateFileStream(str path, uint32 disposition, uint32 access, _Out_ void **stream)"),
    createEvfImageRef: lib.func("uint32 __stdcall EdsCreateEvfImageRef(void *stream, _Out_ void **evf)"),
    downloadEvfImage: lib.func("uint32 __stdcall EdsDownloadEvfImage(void *cam, void *evf)"),
    getPointer: lib.func("uint32 __stdcall EdsGetPointer(void *stream, _Out_ void **pointer)"),
    getLength: lib.func("uint32 __stdcall EdsGetLength(void *stream, _Out_ uint64 *length)"),
    getDirItemInfo: lib.func("uint32 __stdcall EdsGetDirectoryItemInfo(void *item, _Out_ EdsDirectoryItemInfo *info)"),
    download: lib.func("uint32 __stdcall EdsDownload(void *item, uint64 size, void *stream)"),
    downloadComplete: lib.func("uint32 __stdcall EdsDownloadComplete(void *item)"),
    downloadCancel: lib.func("uint32 __stdcall EdsDownloadCancel(void *item)"),
  };

  const OBJECT_EVENT_ALL = 0x200;
  const STATE_EVENT_ALL = 0x300;
  const FILE_CREATE_ALWAYS = 1;
  const ACCESS_READ_WRITE = 2;

  // koffi keeps a registered callback alive until it is unregistered; hold
  // ours so a new session's handler replaces (and frees) the previous one.
  type Registered = ReturnType<typeof koffi.register>;
  let objectCallback: Registered | null = null;
  let stateCallback: Registered | null = null;
  const unregister = (cb: Registered | null) => {
    if (cb) koffi.unregister(cb);
  };

  return {
    initialize: () => f.initialize(),
    terminate: () => {
      unregister(objectCallback);
      unregister(stateCallback);
      objectCallback = stateCallback = null;
      return f.terminate();
    },
    firstCamera() {
      const list: unknown[] = [null];
      if (f.getCameraList(list) !== 0) return null;
      try {
        const count = [0];
        f.getChildCount(list[0], count);
        if (!count[0]) return null;
        const cam: unknown[] = [null];
        if (f.getChildAtIndex(list[0], 0, cam) !== 0) return null;
        const info: { szDeviceDescription?: string } = {};
        f.getDeviceInfo(cam[0], info);
        return { ref: cam[0], description: info.szDeviceDescription || "Canon camera" };
      } finally {
        f.release(list[0]);
      }
    },
    openSession: (cam) => f.openSession(cam),
    closeSession: (cam) => f.closeSession(cam),
    release: (ref) => {
      f.release(ref);
    },
    getU32(cam, prop) {
      const value = [0];
      const err = f.getU32(cam, prop, 0, 4, value);
      return { err, value: value[0] ?? 0 };
    },
    setU32: (cam, prop, value) => f.setU32(cam, prop, 0, 4, [value]),
    setCapacityHost: (cam) => f.setCapacity(cam, { numberOfFreeClusters: 0x7fffffff, bytesPerSector: 0x1000, reset: 1 }),
    sendCommand: (cam, command, param) => f.sendCommand(cam, command, param),
    setObjectHandler(cam, handler) {
      unregister(objectCallback);
      objectCallback = koffi.register((event: number, ref: EdsRef) => {
        handler(event, ref);
        return 0;
      }, koffi.pointer(ObjectHandler));
      return f.setObjectHandler(cam, OBJECT_EVENT_ALL, objectCallback, null);
    },
    setStateHandler(cam, handler) {
      unregister(stateCallback);
      stateCallback = koffi.register((event: number) => {
        handler(event);
        return 0;
      }, koffi.pointer(StateHandler));
      return f.setStateHandler(cam, STATE_EVENT_ALL, stateCallback, null);
    },
    getEvent: () => {
      f.getEvent();
    },
    downloadEvfFrame(cam) {
      const stream: unknown[] = [null];
      let err = f.createMemoryStream(0, stream);
      if (err !== 0) return { err, jpeg: null };
      try {
        const evf: unknown[] = [null];
        err = f.createEvfImageRef(stream[0], evf);
        if (err !== 0) return { err, jpeg: null };
        try {
          err = f.downloadEvfImage(cam, evf[0]);
          if (err !== 0) return { err, jpeg: null };
          const pointer: unknown[] = [null];
          const length = [0];
          f.getPointer(stream[0], pointer);
          f.getLength(stream[0], length);
          const bytes = koffi.decode(pointer[0], koffi.array("uint8", Number(length[0])));
          return { err: 0, jpeg: Buffer.from(bytes as Uint8Array) };
        } finally {
          f.release(evf[0]);
        }
      } finally {
        f.release(stream[0]);
      }
    },
    dirItem(item) {
      const info: { size?: number | bigint; szFileName?: string } = {};
      const err = f.getDirItemInfo(item, info);
      if (err !== 0) return { err, item: null };
      const dirItem: DirItem = { size: BigInt(info.size ?? 0), fileName: info.szFileName ?? "" };
      return { err: 0, item: dirItem };
    },
    downloadToFile(item, size, filePath) {
      const stream: unknown[] = [null];
      let err = f.createFileStream(filePath, FILE_CREATE_ALWAYS, ACCESS_READ_WRITE, stream);
      if (err !== 0) return err;
      try {
        err = f.download(item, size, stream[0]);
        if (err !== 0) return err;
        return f.downloadComplete(item);
      } finally {
        f.release(stream[0]);
      }
    },
    downloadCancel: (item) => f.downloadCancel(item),
  };
}
```

If `tsc` complains about koffi's typings (for example, `koffi.decode` returning `any`, or `lib.func` returning `KoffiFunction`), keep the fix local to this file with an explicit annotation. Don't loosen `tsconfig`.

- [ ] **Step 8: Create `src/camera/edsdk/worker.ts`**

```ts
/**
 * Entry point of the camera worker child process (forked by EdsdkSource with
 * the EDSDK.dll path as argv[2]). Owns the only EDSDK session on the machine;
 * every EDSDK call happens on this process's single thread.
 */
import { CameraWorker } from "./CameraWorker";
import { loadEdsdk } from "./edsdkNative";
import { RequestBody, WorkerMessage, WorkerRequest } from "./protocol";
import { AsyncMutex } from "../../util/mutex";

const TICK_MS = 30;

const dllPath = process.argv[2];
if (!dllPath || !process.send) {
  console.error("camera worker: must be forked by EdsdkSource with the EDSDK.dll path");
  process.exit(2);
}

const send = (message: WorkerMessage): void => {
  process.send?.(message);
};

const worker = new CameraWorker(loadEdsdk(dllPath), send);
worker.start();

const loop = setInterval(() => {
  try {
    worker.tick();
  } catch (err) {
    send({ type: "log", level: "error", message: `tick failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}, TICK_MS);

const captureLock = new AsyncMutex();

function stop(): never {
  clearInterval(loop);
  worker.shutdown();
  process.exit(0);
}

async function handle(request: RequestBody): Promise<Uint8Array | null> {
  switch (request.type) {
    case "capture":
      await captureLock.run(() => worker.capture(request.destPath));
      return null;
    case "frame":
      return worker.frame();
    case "ping":
      return null;
    case "shutdown":
      setImmediate(stop); // answer first, then exit
      return null;
  }
}

process.on("message", (request: WorkerRequest) => {
  handle(request).then(
    (result) => send({ id: request.id, ok: true, result }),
    (err: unknown) => send({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  );
});

// The agent went away without saying goodbye: release the camera anyway.
process.on("disconnect", stop);
```

- [ ] **Step 9: Wire the driver in `src/index.ts`**

Add this import next to the other camera imports:

```ts
import { EdsdkSource, spawnWorker } from "./camera/edsdk/EdsdkSource";
```

Replace `const canonSource = new CanonTetheredSource(config.capture.canon);` with:

```ts
  // `driver` is read once at startup; switching it needs a service restart.
  const canonConfig = config.capture.canon;
  const canonSource =
    canonConfig.driver === "edsdk"
      ? new EdsdkSource(() => spawnWorker(canonConfig.edsdkDllPath))
      : new CanonTetheredSource(canonConfig);
```

- [ ] **Step 10: Update the README**

1. Rename the section "Canon control: why digiCamControl, not EDSDK" to **"Canon control"**.
2. Put this subsection at its top, and keep the existing digiCamControl text below it under a "### digiCamControl driver (legacy)" heading:

```markdown
### EDSDK driver (`capture.canon.driver: "edsdk"`)

The agent drives the R100 through Canon's EDSDK in its own child process (`src/camera/edsdk/`), instead of through digiCamControl. We switched because digiCamControl never releases the shutter button after a failed autofocus (`8D01`); the camera then answers `0x81` (busy) to everything until it is power-cycled. The worker always releases the shutter button, and on `8D01` it retakes the shot without autofocus. See `docs/superpowers/specs/2026-09-25-edsdk-camera-design.md`.

**Setup:**
1. Register with the Canon developer programme and download EDSDK. Copy the **64-bit** `EDSDK.dll` and `EdsImage.dll` into `C:\BoothAgent\edsdk\`. They're not in git: Canon's licence doesn't allow redistributing them. The 32-bit DLL that ships with digiCamControl won't load into 64-bit Node.
2. Close digiCamControl and remove it from startup. Only one program can hold the camera, and preflight warns (`canon.digiCamControlConflict`) if both run.
3. Set `"driver": "edsdk"` under `capture.canon` in `booth.config.json`, then restart the service.
4. Check `/health/preflight`: `canon.edsdkDll` should be `ok`. Then check that `/health` shows `canonConnected: true`.

The worker reconnects on its own after a camera power-cycle or a USB replug. It keeps the camera awake while connected, turns live view on when the kiosk asks for frames, and turns it off again after 10 s without one. If the worker crashes or hangs, the agent restarts it; the webcam covers in the meantime.
```

3. Add two rows to the configuration reference table:

```markdown
| `capture.canon.driver` | `"digicamcontrol"` (default) or `"edsdk"`: how the Canon is controlled. Read at startup; restart the service after changing it. |
| `capture.canon.edsdkDllPath` | Where the 64-bit `EDSDK.dll` lives. Default `C:\BoothAgent\edsdk\EDSDK.dll`. |
```

- [ ] **Step 11: Full verification**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build`
Expected: typecheck clean; all tests pass (the previous 202 plus 19 worker, 9 source and 4 config tests, 234 in total); `dist/camera/edsdk/worker.js` exists.

- [ ] **Step 12: Commit, push and open the PR**

```bash
git add package.json package-lock.json src tests/edsdk.config.test.ts README.md
git commit -m "feat(edsdk): native binding, worker process, driver switch and preflight" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/edsdk-camera
gh pr create --base master --title "feat(camera): EDSDK camera worker (phase 1)" --body "<summary, spec link, test counts, 'default driver unchanged; live check waits for the 64-bit EDSDK', Claude Code line>"
```

Merge only when the user says so. Merging is safe before the DLL arrives, because the default driver is still `digicamcontrol`. After the merge:
1. `git checkout master && git pull --ff-only && npm run build`
2. The user restarts the service.
3. Confirm that `ranAt` changed and that the camera still works through digiCamControl.

---

### Task 6: Live verification on the booth (blocked until the 64-bit EDSDK is installed)

This task has no code unless it finds a bug. If it does, fix it with a failing test first, in a follow-up PR.

- [ ] **Step 1: Install the DLL.** Copy the official 64-bit `EDSDK.dll` and `EdsImage.dll` to `C:\BoothAgent\edsdk\`. Check the bitness: the PE machine field must be `0x8664`.

```powershell
foreach ($f in 'C:\BoothAgent\edsdk\EDSDK.dll') { $b=[IO.File]::ReadAllBytes($f); $pe=[BitConverter]::ToInt32($b,0x3C); '{0:X}' -f [BitConverter]::ToUInt16($b,$pe+4) }
```

- [ ] **Step 2: Switch drivers.**
  1. Close digiCamControl (`taskkill /IM CameraControl.exe`), and ask the user to remove `digiCamControl.lnk` from `shell:startup`.
  2. Set `"driver": "edsdk"` in `C:\Users\User\Documents\booth-agent\booth.config.json`.
  3. The user restarts the service. Confirm that `ranAt` changed, that preflight shows `canon.edsdkDll` ok and `canon.digiCamControlConflict` ok, and that `/health` shows `activeSource: "canon"` and `activeModel: "Canon EOS R100"`.
- [ ] **Step 3: Run the checklist.** Watch `dist/daemon/boothagent.out.log` for `[camera:edsdk]` lines throughout.
  1. A normal kiosk session, with no print (tap ✕ on Review).
  2. With the lens covered, run a kiosk session. Expect the `Autofocus failed (8D01) - taking this shot without autofocus` warning, all 4 shots taken, and the camera still usable afterwards.
  3. Unplug and replug the USB cable. `/health` goes false, then back to true within a few seconds, with no restart.
  4. Power-cycle the camera, with the same expectation as step 3.
  5. Kill the worker (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`, find the one whose command line contains `worker.js`, then `Stop-Process`). The log shows the restart and live view comes back.
  6. Soak for 30 minutes: keep the kiosk on the live-view screen (raise `IDLE_MS` temporarily in a local build only, never committed), and capture once a minute through `POST /capture`. Check for no disconnects and no overheating warning on the camera.
  7. Run a full guest session with a print, **only after the user OKs using paper**.
- [ ] **Step 4: Record the results.** Update the memory file `edsdk-camera-project.md`. If `EdsGetCameraList` never needed the 5-scan re-init, note it; that re-init can go in phase 5.

If Canon's approval drags on, there's a stopgap for testing only. It is not part of the design. Run the worker under the 32-bit Node 22 from the spike, with koffi's ia32 build installed in a scratch copy of `dist`, against digiCamControl's 32-bit DLL. Ask the user before setting it up.
