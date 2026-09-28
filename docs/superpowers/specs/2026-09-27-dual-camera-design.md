# Dual camera: a high and a low Canon in one session

Status: approved in chat on 2026-09-27. Builds on the EDSDK driver (`2026-09-25-edsdk-camera-design.md`).

## Goal

The booth gets two Canon EOS R100s. One is mounted high and shoots down; the other is mounted low and shoots up. A layout decides, for each of the guest's photos, which camera takes it. For example, a 2x2 sheet can hold photo 1 from the high camera, photo 2 from the low one, and so on.

- A photo is taken by exactly one camera. The two cameras never fire together; that is out of scope.
- Layouts, sessions and the kiosk keep working unchanged with one camera. A layout that says nothing about cameras uses the high one.

## Decisions

| Question | Decision |
|---|---|
| Who picks the camera for each photo? | The layout, per photo element (option C). The editor has a "high / low" switch and an "alternate high/low" button. |
| Second camera | A second R100, driven by EDSDK. digiCamControl cannot be used for either camera: it grabs every Canon it sees, and its remote command only drives the selected one. |
| Process model | One camera worker process per camera (approach 1). The fallback is one worker for both (approach 2), if two processes can't share EDSDK on the real hardware. |
| Default for new layouts | Every photo uses the high camera. "Alternate high/low" is one tap away. |

## Camera slots and identity

The agent has two fixed slots: `high` and `low`. Each slot is an `EdsdkSource` with its own worker. The worker is today's `CameraWorker`, told which camera body it owns.

**Serial numbers.** Each R100 is identified by its body serial (`kEdsPropID_BodyIDEx`, 0x15, a string). The serial can only be read with a session open, so a worker's scan works like this:

1. List the cameras (`EdsGetCameraList`) and try each in turn.
2. `openSession` fails on a camera that the other worker already holds; skip it.
3. On a camera it can open, read the serial:
   - It matches the slot's saved serial: keep the camera and finish setup as today.
   - It doesn't match: close the session, release the camera and try the next one.
   - The slot has no saved serial: keep the first camera it can open.

**`<dataDir>/cameras.json`** holds `{ "high": "<serial>", "low": "<serial>" }` and is absent until the operator confirms the pairing. Each worker gets its slot's serial (or none) as a second argv entry.

**First setup.** With no `cameras.json`, each worker takes whichever free camera it opens first, so which is which is arbitrary. The operator panel shows both live views side by side with their serials:
- **Swap** exchanges the two serials.
- **Remember** writes the current pairing to `cameras.json`.

Either action restarts both workers with their serials.

**One camera plugged in.** Only one slot connects; the other reports "not connected". See Health for how loud that is.
The low worker only claims a body when at least two are connected and it has no saved serial, so a lone body always ends up in the high slot.

**Driver.** Two slots exist only with `capture.canon.driver: "edsdk"`. Under digiCamControl there is one camera, and a `low` request is served by it (see Fallback) with a warning in the log.

**Per-camera settings.** `camera.json` becomes per slot: `camera-high.json` and `camera-low.json`. On first start, an existing `camera.json` is renamed to `camera-high.json`. Each worker re-applies only its own file on connect.

## Agent

### CameraManager

Sources become `canon-high`, `canon-low` and `webcam`. Health polling, debounce and the events work per source, as today. `capture`, `prefocus`, `getLiveviewFrame` and the settings calls take a `camera: "high" | "low"` argument that defaults to `high`.

**Fallback order for a capture:** the requested slot, then the other Canon slot, then the webcam. The result carries both `camera` (the slot actually used, or `webcam`) and `source`. A low-to-high fallback is logged. The existing `camera-fallback` event still covers Canon-to-webcam.

Live view and pre-focus follow the same routing as the capture. A `low` request with the low camera down shows and focuses the camera that will actually take the photo, so the guest never looks at a black screen.

### API

Everything stays backward compatible: with no camera given, it means `high`.

| Route | Change |
|---|---|
| `POST /capture` | Optional body `{ camera: "high" \| "low" }`. The response gains `camera`. |
| `GET /liveview?camera=low` | Stream from that slot. |
| `POST /camera/prefocus` | Optional body `{ camera }`. |
| `GET/POST /camera/settings?camera=low`, `POST /camera/settings/reset?camera=`, `POST /camera/test-shot?camera=` | Per slot. The test shot fails with 409 instead of falling back, because the operator is judging that camera. |
| `GET /cameras` (new) | `{ slots: { high: { connected, model, serial, remembered }, low: {...} } }`. `remembered` is the serial saved for that slot, or null. |
| `POST /cameras/swap` (new) | Exchanges the two slots' serials, writes `cameras.json` and restarts both workers. |
| `POST /cameras/remember` (new) | Writes the currently connected serials to `cameras.json`. |

All routes are GET or POST (CORS allowlist) behind the existing bearer auth.

### Outbox

Captures get a nullable `camera` column (`high`, `low` or `webcam`), added by the existing `ensureColumn` migration. It is local only; what is uploaded to Supabase does not change.

### Health

- `camera` keeps its current shape and describes the high slot, so older kiosks keep working.
- New `cameras: { high: CameraDetail & { connected, serial }, low: ... }`.
- `camera-low-none` (only when a low slot exists, i.e. under EDSDK): **error** when the active session layout has a photo on the low camera. There is no alert when the layout doesn't use it, so a single-camera EDSDK booth stays green; `cameras.low.connected` still shows the state.

  The high slot keeps today's `camera-none` and `camera-fallback` alerts.
- The existing battery, RAW-only and conflict alerts are reported per slot. Their code gets a `-low` suffix for the low slot; the high slot keeps today's codes.

## Layouts and the editor

**Model.** The photo element gains `camera: "high" | "low"`, defaulting to `high`. The layout schema rejects a layout in which two photo elements show the same `shot` with different cameras. A shot is taken once, so it has one camera.

**Editor.**
- The photo properties panel gains a "Camera: High / Low" switch next to the shot selector. Changing it updates every element showing that shot.
- The canvas and the Settings thumbnails show a small arrow beside the photo number: ↓ for high (it looks down), ↑ for low.
- An "Alternate high/low" button in the Add panel sets shots 1, 3, … to high and 2, 4, … to low.

## Kiosk guest flow (GetReady)

For each photo, the kiosk finds the camera from the layout (`cameraForShot(template, shot)`, which reads the first photo element with that shot) and then:

- points the live view `<img>` at `/liveview?camera=<slot>`. The countdown is at least 3 s, which covers the live view start-up.
- sets the prompt:
  - high: "Photo 2 of 4 · look up at the top camera", with an up arrow;
  - low: "Photo 2 of 4 · look down at the lower camera", with a down arrow;
- sends `{ camera }` with the pre-focus call and the capture.

Retry, ✕, Review, compositing and printing are unchanged. The compositor only places shots in order.

## Operator panel

- **Camera tab.** Two columns, High and Low. Each has:
  - live view;
  - model, serial and connection state;
  - that camera's settings selects;
  - a test shot.

  Above the columns sit the pairing state ("remembered" or "not remembered yet") and the Swap and Remember buttons.
- **Status tab.** Battery, mode, AF, quality and last issue for each camera.

## Testing

**Unit tests, with no hardware.**
- `FakeEds` models several cameras, each with a serial, and a camera "held elsewhere" whose `openSession` fails.
- Worker tests:
  - it keeps only its serial;
  - it skips a held camera;
  - it closes and releases a non-matching camera;
  - with no serial, it takes the first free camera.
- Manager and source tests:
  - routing per slot;
  - fallback order: requested, then the other Canon, then webcam;
  - live view and pre-focus don't fall back;
  - `cameras.json` swap and remember;
  - per-slot settings files and the `camera.json` rename.
- Route tests: the defaults (no camera means high) and the per-slot 409s.
- Health tests: the error/warn level of a missing slot depends on the layout.
- Layout tests: shot/camera consistency, and `camera` defaults to high.
- Kiosk tests: `cameraForShot`. The editor is checked by hand on the dev kiosk.

**Hardware checks.** These are added to EDSDK Task 6, once the 64-bit DLL arrives.
1. **First:** two worker processes each hold one R100 at the same time, with live view and capture on both. If this fails, switch to approach 2 before anything else.
2. Swap and Remember; unplug and replug each camera and check that it comes back to the same slot.
3. An AF failure or a cable pull on one camera: the other keeps working, and the shot falls back to it.
4. Both cameras on separate USB ports with AC power: check CPU and USB stability through a 20-guest run.

## Phases (one PR each)

1. **Agent dual camera.**
   - The serial read, the serial-matching scan and the worker argv.
   - Two `EdsdkSource` slots in the manager, with fallback.
   - The API, `cameras.json`, per-slot settings files, the outbox column and health.
   - The layout schema's `camera` field and its validation, because health needs to know whether the layout uses the low camera.
2. **Layouts and guest flow.** The editor switch/arrows/alternate button, and the GetReady camera switching and prompts.
3. **Operator panel.** The two-column Camera tab, Swap and Remember, and the Status tab.

Until the driver is switched to `edsdk`, all three phases behave exactly like today: one camera, and every photo on it. So they can be merged and deployed before the DLL arrives.

## Out of scope

- Both cameras firing at once.
- AI mode ("Pick your look").
- A webcam as a named slot.
- More than two cameras.
- Uploading which camera took a photo to Supabase.

## Spike result (2026-09-28, two R100s, 32-bit EDSDK 13.18.40, throwaway code)

- Two processes each held one R100 at the same time. Each opened its body by serial (`kEdsPropID_BodyIDEx` read fine: `378032000939` and `358032000832`).
- Live view ran on both at once at about 15 fps each. Both shutters fired within the same second, and the photo downloaded normally.
- Opening a body the other process holds blocks for **about 3 s** and then fails with `0xC0`. So a worker remembers which serial sits on which USB port (`szPortName`, readable without a session) and retries a held port only every 15 s. Otherwise an unconnected worker would block every scan and miss its pings.
- 8D01 (AF failure) happened on one body aimed at a low-contrast scene; the non-AF shot worked. This is not a dual-camera issue.

Approach 1 is confirmed. The 64-bit DLL still needs the same check.

## Risks

- **Two processes sharing EDSDK on different bodies is not documented by Canon.** The 32-bit spike passed. If the 64-bit DLL behaves differently, approach 2 replaces only the worker layer: one worker holds both sessions, and requests carry the slot.
- **Two R100s streaming and capturing on one PC:** USB bandwidth and power. Mitigate with separate ports and AC adapters, and measure in hardware check 4.
