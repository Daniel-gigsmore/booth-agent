# EDSDK camera control: phase 2 (pre-focus) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the kiosk countdown reaches 1.5 s, the camera half-presses the shutter so autofocus is done before the shot. It releases by itself after 3 s if no capture follows.

**Architecture:** The kiosk `Countdown` fires a fire-and-forget `POST /camera/prefocus`. The route calls `CameraManager.prefocus()`, which forwards to the active source's optional `prefocus()`. Only `EdsdkSource` implements it; it sends a `prefocus` IPC request to the worker. `CameraWorker.prefocus()` sends `PressShutterButton Halfway` and holds it. The next `capture()` presses fully as usual; its OFF releases everything. `tick()` releases a hold that is older than 3 s.

**Tech Stack:** TypeScript (strict, CommonJS agent; Vite/React kiosk), vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-edsdk-camera-design.md`, section "Pre-focus during the countdown".

## Global Constraints

- Kiosk: at 1.5 s before zero, `GetReady` calls `POST /camera/prefocus`. It is fire-and-forget: a failure is ignored and the countdown never waits for it.
- Agent: `CameraManager.prefocus()` forwards to the active source. The call is optional on `CameraSource`; the webcam and digiCamControl sources don't implement it.
- Worker:
  - sends `PressShutterButton Halfway` (1) and holds it;
  - if the half-press returns an error, releases (OFF) right away;
  - if no capture arrives within **3 s**, releases (OFF) by itself.
- Pre-focus is only an optimisation. Capture works the same whether or not pre-focus ran or failed.
- `POST /camera/prefocus` returns 202 whatever happens. It uses the existing bearer auth, and it is POST, which fits the CORS allowlist.
- Every shutter press is still followed by OFF (phase 1 rule).
- The agent-side prefocus request uses `TIMEOUT_MS.other` (3 s).
- Tests never load koffi or the DLL.
- Comments, commit messages and PR text are in English. Every commit ends with a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` line naming the model that wrote it.
- Deploy order: the agent first (restart), then the kiosk. There are no new dependencies.

---

### Task 1: Agent side (worker, IPC, source, manager, route)

**Files:**
- Modify: `src/camera/edsdk/edsdkApi.ts` (add `SHUTTER_HALFWAY`)
- Modify: `src/camera/edsdk/CameraWorker.ts` (`prefocus()`, hold state, auto-release in `tick()`, clear on capture/disconnect)
- Modify: `src/camera/edsdk/protocol.ts` (`{ type: "prefocus" }`)
- Modify: `src/camera/edsdk/worker.ts` (dispatch `prefocus`)
- Modify: `src/camera/edsdk/EdsdkSource.ts` (`prefocus()`)
- Modify: `src/camera/CameraSource.ts` (optional `prefocus?()`)
- Modify: `src/camera/CameraManager.ts` (`prefocus()`)
- Modify: `src/server/routes.ts` (`POST /camera/prefocus`)
- Modify: `README.md` (API section: one row or line for the new route)
- Test: `tests/edsdk.worker.test.ts`, `tests/edsdk.source.test.ts`, new `tests/camera.prefocus.test.ts`

**Interfaces:**
- Produces:
  - `CameraWorker.prefocus(): void`
  - `EdsdkSource.prefocus(): Promise<void>`
  - `CameraSource.prefocus?(): Promise<void>`
  - `CameraManager.prefocus(): Promise<void>`, which never rejects
  - HTTP `POST /camera/prefocus` → 202, empty JSON `{}`

- [ ] **Step 1: Write the failing worker tests (append to `tests/edsdk.worker.test.ts`)**

```ts
describe("CameraWorker pre-focus", () => {
  beforeEach(() => {
    makeWorker();
    worker.tick(); // connected; the connect-time OFF is presses[0]
  });

  it("half-presses and holds until the capture presses fully", async () => {
    worker.prefocus();
    expect(eds.presses).toEqual([EDS.SHUTTER_OFF, EDS.SHUTTER_HALFWAY]);
    await worker.capture(dest());
    expect(eds.presses).toEqual([EDS.SHUTTER_OFF, EDS.SHUTTER_HALFWAY, EDS.SHUTTER_COMPLETELY, EDS.SHUTTER_OFF]);
  });

  it("releases the half-press by itself after 3 s without a capture", () => {
    worker.prefocus();
    clock.advance(2_999);
    worker.tick();
    expect(eds.presses.at(-1)).toBe(EDS.SHUTTER_HALFWAY);
    clock.advance(1);
    worker.tick();
    expect(eds.presses.at(-1)).toBe(EDS.SHUTTER_OFF);
    clock.advance(10_000);
    worker.tick();
    expect(eds.presses.filter((p) => p === EDS.SHUTTER_OFF)).toHaveLength(2); // connect + auto-release, not again
  });

  it("releases right away when the half-press fails", () => {
    eds.pressResults = [EDS.ERR_TAKE_PICTURE_AF_NG];
    worker.prefocus();
    expect(eds.presses).toEqual([EDS.SHUTTER_OFF, EDS.SHUTTER_HALFWAY, EDS.SHUTTER_OFF]);
    clock.advance(3_000);
    worker.tick();
    expect(eds.presses).toHaveLength(3); // nothing left to auto-release
  });

  it("does nothing with no camera or during a capture", async () => {
    eds.photoNames = [];
    const capture = worker.capture(dest());
    const before = eds.presses.length;
    worker.prefocus();
    expect(eds.presses).toHaveLength(before);
    await expect(capture).rejects.toThrow("timed out");

    eds.unplug();
    worker.tick();
    const afterUnplug = eds.presses.length;
    worker.prefocus();
    expect(eds.presses).toHaveLength(afterUnplug);
  });

  it("forgets a held half-press when the camera disconnects", () => {
    worker.prefocus();
    eds.unplug();
    worker.tick();
    eds.camera = "Canon EOS R100";
    clock.advance(1_000);
    worker.tick(); // reconnects
    const count = eds.presses.length;
    clock.advance(3_000);
    worker.tick();
    expect(eds.presses).toHaveLength(count); // no stale auto-release on the new session
  });
});
```

Note: `FakeEds.sendCommand` consumes `pressResults` for every non-OFF press, including Halfway (1). A successful Halfway press must NOT queue a photo transfer. Update `FakeEds.sendCommand` so it only queues `photoNames` for full presses (`param === EDS.SHUTTER_COMPLETELY || param === EDS.SHUTTER_COMPLETELY_NON_AF`).

- [ ] **Step 2: Write the failing source, manager and route tests**

Append to `tests/edsdk.source.test.ts`:

```ts
describe("EdsdkSource pre-focus", () => {
  it("sends a prefocus request to the worker", async () => {
    await source.prefocus();
    expect(current().sent.some((r) => r.type === "prefocus")).toBe(true);
  });
});
```

Create `tests/camera.prefocus.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { CameraManager } from "../src/camera/CameraManager";
import { CameraSource } from "../src/camera/CameraSource";
import { EventBus } from "../src/events/eventBus";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";

function fakeSource(kind: "canon" | "webcam", prefocus?: () => Promise<void>): CameraSource {
  return {
    kind,
    initialize: async () => true,
    shutdown: async () => {},
    isHealthy: async () => true,
    capture: async () => ({ filePath: "x.jpg", width: 1, height: 1 }),
    getLiveviewFrame: async () => null,
    getModel: () => kind,
    ...(prefocus ? { prefocus } : {}),
  };
}

describe("CameraManager.prefocus", () => {
  it("forwards to the active source", async () => {
    const prefocus = vi.fn(async () => {});
    const manager = new CameraManager({ canon: fakeSource("canon", prefocus), webcam: fakeSource("webcam") }, "canon", new EventBus(), 60_000);
    await manager.start();
    await manager.prefocus();
    expect(prefocus).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("is a no-op for a source without pre-focus, and never rejects", async () => {
    const failing = new CameraManager(
      { canon: fakeSource("canon", async () => { throw new Error("worker gone"); }), webcam: fakeSource("webcam") },
      "canon", new EventBus(), 60_000
    );
    await failing.start();
    await expect(failing.prefocus()).resolves.toBeUndefined();
    await failing.stop();

    const webcamOnly = new CameraManager({ canon: fakeSource("canon"), webcam: fakeSource("webcam") }, "webcam", new EventBus(), 60_000);
    await webcamOnly.start();
    await expect(webcamOnly.prefocus()).resolves.toBeUndefined();
    await webcamOnly.stop();
  });
});

describe("POST /camera/prefocus", () => {
  const SECRET = "test-secret";
  const prefocus = vi.fn(async () => {});
  let server: Server;
  let base: string;

  beforeAll(() => {
    const ctx = {
      configStore: { current: { agent: { allowedOrigins: [], sharedSecret: SECRET } } },
      cameraManager: { prefocus },
    } as unknown as AgentContext;
    server = buildHttpApp(ctx).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it("answers 202 and asks the camera to pre-focus", async () => {
    const res = await fetch(`${base}/camera/prefocus`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(202);
    expect(prefocus).toHaveBeenCalledTimes(1);
  });

  it("still answers 202 when pre-focus fails", async () => {
    prefocus.mockRejectedValueOnce(new Error("boom"));
    const res = await fetch(`${base}/camera/prefocus`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(202);
  });
});
```

If `CameraManager`'s constructor or `start()` signature differs from what this test assumes, read `src/camera/CameraManager.ts` and `tests/camera.fallback.test.ts` and match them. Keep the test's intent unchanged.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/edsdk.worker.test.ts tests/edsdk.source.test.ts tests/camera.prefocus.test.ts`
Expected: the new tests FAIL (`worker.prefocus is not a function`, `source.prefocus is not a function`, `manager.prefocus is not a function`, and a 404 from the route).

- [ ] **Step 4: Implement the worker part**

In `src/camera/edsdk/edsdkApi.ts`, add `SHUTTER_HALFWAY: 1,` next to `SHUTTER_OFF`.

In `src/camera/edsdk/CameraWorker.ts`:

```ts
const PREFOCUS_HOLD_MS = 3_000;
```

Add a field:

```ts
  /** When the pre-focus half-press started, or null when the shutter isn't held. */
  private halfPressedAt: number | null = null;
```

Add the method:

```ts
  /**
   * Half-presses the shutter so AF has already locked when the countdown hits
   * zero (the kiosk calls this ~1.5 s early). Purely an optimisation: capture()
   * presses fully either way, and its OFF releases this hold too.
   */
  prefocus(): void {
    const cam = this.cam;
    if (!cam || this.capturing) return;
    const err = this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_HALFWAY);
    if (err !== EDS.ERR_OK) {
      this.eds.sendCommand(cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_OFF);
      this.check(err, "pre-focus");
      return;
    }
    this.halfPressedAt = this.clock.now();
  }
```

In `tick()`, inside the connected branch after the live-view idle check:

```ts
    // A guest who tapped ✕, or a kiosk that went away, must not leave the shutter half-pressed.
    if (this.halfPressedAt !== null && !this.capturing && now - this.halfPressedAt >= PREFOCUS_HOLD_MS) {
      this.halfPressedAt = null;
      this.eds.sendCommand(this.cam, EDS.CMD_PRESS_SHUTTER_BUTTON, EDS.SHUTTER_OFF);
    }
```

In `capture()`, right after `this.capturing = true;`:

```ts
    this.halfPressedAt = null; // the full press takes over; press() releases afterwards
```

In `disconnect()`, next to `this.liveviewOn = false;`:

```ts
    this.halfPressedAt = null;
```

In `tests/helpers/fakeEdsdk.ts` `sendCommand`: queue `photoNames` transfers only when `param` is `EDS.SHUTTER_COMPLETELY` or `EDS.SHUTTER_COMPLETELY_NON_AF` (see the note in Step 1).

- [ ] **Step 5: Implement the IPC, source, manager and route parts**

`src/camera/edsdk/protocol.ts`: add `| { type: "prefocus" }` to `RequestBody`.

`src/camera/edsdk/worker.ts`, in `handle()`, add the case below. It is deliberately not behind `captureLock`: a pre-focus must never queue behind a capture, and `CameraWorker.prefocus()` ignores calls while a capture runs.

```ts
    case "prefocus":
      worker.prefocus();
      return null;
```

`src/camera/edsdk/EdsdkSource.ts`:

```ts
  /** Asks the worker to half-press now so focus is ready at zero. */
  async prefocus(): Promise<void> {
    await this.request({ type: "prefocus" }, TIMEOUT_MS.other);
  }
```

`src/camera/CameraSource.ts`, in the interface:

```ts
  /** Optional: start focusing now because a capture is about to happen. Sources without it just capture normally. */
  prefocus?(): Promise<void>;
```

`src/camera/CameraManager.ts`:

```ts
  /** Best-effort: never rejects, since the capture works the same without it. */
  async prefocus(): Promise<void> {
    if (this.active === "none") return;
    try {
      await this.sources[this.active].prefocus?.();
    } catch (err) {
      log.debug(`Pre-focus failed on ${this.active}`, err);
    }
  }
```

`src/server/routes.ts`, next to `/capture`:

```ts
  // The kiosk calls this ~1.5 s before each shot so autofocus is done by the
  // time /capture arrives. Fire-and-forget: the answer never waits on the camera.
  router.post("/camera/prefocus", (_req: Request, res: Response) => {
    // prefocus() never rejects, but a floating promise must not become an
    // unhandled rejection if that ever changes (or a test double rejects).
    ctx.cameraManager.prefocus().catch(() => undefined);
    res.status(202).json({});
  });
```

In the README's API section, add `POST /camera/prefocus`, described as: 202; asks the camera to autofocus now for an imminent capture; a no-op unless the EDSDK driver is active. Follow the section's existing format.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/edsdk.worker.test.ts tests/edsdk.source.test.ts tests/camera.prefocus.test.ts`, then `npx vitest run`, then `npx tsc -p tsconfig.json --noEmit`.
Expected: all pass (239 + 5 worker + 1 source + 4 manager/route = 249), and tsc is clean.

- [ ] **Step 7: Commit**

```bash
git add src tests README.md
git commit -m "feat(edsdk): pre-focus - half-press on request, auto-release after 3 s" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 2: Kiosk countdown hook

**Files:**
- Modify: `kiosk/src/agent.ts` (`agent.prefocus()`)
- Modify: `kiosk/src/screens.tsx` (`Countdown` gets `onPrefocus`; `GetReady` passes it)

**Interfaces:**
- Consumes: `POST /camera/prefocus` (Task 1)
- Produces: `agent.prefocus(): void`, which is fire-and-forget and never throws

- [ ] **Step 1: Add the client call to `kiosk/src/agent.ts`**

Add this entry to the exported `agent` object, following its style:

```ts
  /** Fire-and-forget: tells the camera a shot is ~1.5 s away. A failure never affects the countdown. */
  prefocus: () => {
    void call("POST", "/camera/prefocus").catch(() => undefined);
  },
```

- [ ] **Step 2: Fire it from the countdown in `kiosk/src/screens.tsx`**

Replace `Countdown` with:

```tsx
/** How long before zero the camera is asked to focus. */
const PREFOCUS_LEAD_MS = 1_500;

/** Remounted per shot (via key) so each shot gets a fresh countdown and its own pre-focus. */
function Countdown({ seconds, onZero, onPrefocus }: { seconds: number; onZero: () => void; onPrefocus: () => void }) {
  const n = useCountdown(seconds, onZero);
  useEffect(() => {
    const t = setTimeout(onPrefocus, Math.max(0, seconds * 1000 - PREFOCUS_LEAD_MS));
    return () => clearTimeout(t);
    // Once per mount: `seconds` is fixed for this shot and the parent's callback identity doesn't matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div className="count display">{Math.max(n, 1)}</div>;
}
```

In `GetReady`, pass `onPrefocus={agent.prefocus}` to `<Countdown>`. `agent` is already imported from `./agent` in screens.tsx; if it isn't, add it to the import.

Leave the eslint comment out if the kiosk has no eslint config (check for `kiosk/.eslintrc*` or `eslint` in `kiosk/package.json`). Keep the explanatory comment either way.

- [ ] **Step 3: Verify**

Run in `kiosk/`: `npm run build` (tsc + vite) and `npx vitest run`.
Expected: the build is clean and 23 tests pass.

The timer is a one-line effect, so there is no unit test for it. Behaviour is covered by the agent route test plus the live check below.

- [ ] **Step 4: Commit**

```bash
git add kiosk/src/agent.ts kiosk/src/screens.tsx
git commit -m "feat(kiosk): ask the camera to pre-focus 1.5 s before each shot" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Deploy and live check (controller, after merge, with the user)

1. The agent first:
   1. `git pull --ff-only && npm run build` in the main checkout (no new dependencies);
   2. the user restarts the service;
   3. check that `ranAt` changed.
2. The kiosk: robocopy `kiosk\src` with /MIR and copy the top-level files, per `kiosk/README.md`, then `npm run build` in `C:\BoothAgent\kiosk`. The user reloads the kiosk.
3. With the digiCamControl driver still active, run a kiosk session. `POST /camera/prefocus` fires about 1.5 s before each shot and answers 202. The capture behaves exactly as before, because the manager no-ops for `CanonTetheredSource`.
4. The real half-press behaviour is checked in phase 1 Task 6 once the 64-bit EDSDK is installed. Add to that checklist: the countdown with pre-focus gives sharp shots, and a ✕ during the countdown releases within 3 s (the worker log shows no stuck shutter; the next session captures normally).
