# EDSDK camera control: replacing digiCamControl

Date: 2026-09-25
Status: approved design, not yet implemented

## Goal

booth-agent should control the Canon EOS R100 directly through Canon's EDSDK
instead of going through digiCamControl, so that:

- a failed autofocus never locks the camera up;
- live view stays smooth and never freezes on a stale frame;
- the camera reconnects by itself after a power cycle or a USB replug;
- the camera pre-focuses during the countdown;
- the operator can change camera settings from the kiosk; and
- /health shows real camera status (battery, mode, quality).

## Why

On 2026-09-25 a live session failed on shot 3 with `Canon error code: 8D01`
(`EDS_ERR_TAKE_PICTURE_AF_NG`). From then on every command came back as
`0x81` (`EDS_ERR_DEVICE_BUSY`), for as long as anyone waited, until the camera
was power-cycled. Live view froze on its last frame the whole time.

digiCamControl's source code explains it. In live view,
`CanonSDKBase.CapturePhoto()` does three things:

1. `ResetShutterButton()`
2. `SendCommand(TakePicture)`
3. `ResetShutterButton()`

When step 2 throws, the catch block skips step 3, so the camera is left with its
shutter button logically held down. PR #46's `CaptureNoAf` fallback could not
help, because the camera was already wedged by the time it ran. We can't fix
this from outside digiCamControl.

## Spike results (2026-09-25, throwaway code)

The spike used 32-bit Node 22 with `koffi` 3.3.1, loading the 32-bit
`EDSDK.dll` 13.18.40 that ships with digiCamControl. digiCamControl was closed
for the test.

| Check | Result |
|---|---|
| Enumerate + open session | "Canon EOS R100" found; props read (AEMode 3 = M, AFMode 1 = AI Servo, battery 0xFFFFFFFF = AC) |
| Live view (`Evf_OutputDevice` \|= PC, `EdsDownloadEvfImage`) | 960x640, 17-19 fps, ~210 KB per frame |
| Capture: `PressShutterButton` Completely (3), then OFF (0); SaveTo = Host; download on `DirItemRequestTransfer` (0x208) via `EdsGetEvent` polling | 1.1-1.4 s from command to file on disk |
| Non-AF capture: `Completely_NonAF` (0x10003), then OFF | works, ~1.2 s |
| A real 8D01, then OFF, then an immediate non-AF shot and an AF shot | both succeeded; the camera never wedged |
| Lens covered: AF shot, then non-AF shot, then AF shot | all three succeeded; live view kept running |
| Run as `SYSTEM` (session 0, via a scheduled task) | camera found, live view at 19.4 fps, AF shot OK |

Conclusions:

- **Always send `PressShutterButton OFF` after any press, whether it succeeded
  or failed.** That alone removes the lockup.
- The agent service, which runs as LocalSystem, can own the camera directly.
- EDSDK 13.x uses `uint64` for stream lengths, `EdsDownload` sizes and
  `EdsDirectoryItemInfo.size` (offset 0).

## Architecture

```
booth-agent service (64-bit Node)
 ├─ CameraManager (unchanged)
 │    ├─ EdsdkSource       new: implements CameraSource
 │    │     │ child_process.fork IPC (serialization: "advanced", Buffers)
 │    │     ▼
 │    │   camera worker    new child process, same TypeScript build
 │    │     └─ koffi -> EDSDK.dll -> USB -> R100
 │    └─ WebcamSource (unchanged fallback)
 └─ print, sync, compositor: unchanged
```

- **Camera worker** (`src/camera/edsdk/worker.ts`). This is the only code that
  touches EDSDK. It owns one EDSDK session and runs every call on its own single
  thread. Commands run one at a time from a queue. Its native code is isolated,
  so a crash can't take down the agent's print or sync work.
- **EDSDK binding** (`src/camera/edsdk/edsdk.ts`) holds the koffi declarations
  and constants behind a small `EdsApi` interface. The worker only sees
  `EdsApi`, so tests can swap in a fake.
- **EdsdkSource** (`src/camera/edsdk/EdsdkSource.ts`) implements `CameraSource`.
  It spawns and supervises the worker, turns method calls into IPC requests with
  timeouts, caches the connection state the worker pushes (so `isHealthy()` is
  instant), and respawns the worker when it crashes or hangs.
- **Protocol** (`src/camera/edsdk/protocol.ts`) holds the typed request and
  response messages shared by both sides. Each request carries an `id`, and each
  response echoes it with `{ ok, result | error }`. The worker also pushes
  `state` and `log` events on its own.

### Config

`capture.canon` gains:

```json
"driver": "digicamcontrol" | "edsdk",
"edsdkDllPath": "C:\\BoothAgent\\edsdk\\EDSDK.dll"
```

- `driver` defaults to `"digicamcontrol"` until phase 5, when it flips to
  `"edsdk"` and the digiCamControl code is deleted.
- `index.ts` picks `CanonTetheredSource` or `EdsdkSource` based on `driver`.
- The digiCamControl-only fields (`digiCamControlExePath` and the rest) stay
  as they are, still required, until phase 5 deletes them together with
  `CanonTetheredSource`.

### The DLL

- Production uses the official **64-bit** `EDSDK.dll` (and `EdsImage.dll`) from
  the Canon developer programme, installed to `C:\BoothAgent\edsdk\`.
- The DLLs are never committed, because Canon's licence doesn't allow
  redistributing them publicly. The README documents the install step.
- The 32-bit DLL bundled with digiCamControl can't load into 64-bit Node.

`koffi` becomes a runtime dependency. Its prebuilt binaries cover win32-x64 and
the CI platforms.

## Capture

The worker's `capture(destPath)` runs these steps:

1. If live view is on, stop pulling frames (the frame requests return `null`
   until capture finishes).
2. If a pre-focus half-press is being held (see below), go straight to a full
   press. Otherwise press `Completely`.
3. **Always** send `PressShutterButton OFF` right after the press returns,
   whatever the result.
4. If the press returned `0x8D01` (AF failed), press `Completely_NonAF`, then OFF.
   Log it at WARN level and record it as the source's `lastError`.
5. If the press returned `0x81` (busy), send OFF, wait 500 ms and retry the same
   press once. Always follow a retry with OFF too.
6. Wait for `DirItemRequestTransfer`. Pump `EdsGetEvent` every 30 ms. Download to
   `destPath` through a file stream, then call `EdsDownloadComplete`. If the item
   isn't a JPEG, call `EdsDownloadCancel` and keep waiting. After 10 s without a
   JPEG, fail with a clear error.
7. Resume live view.

At session open the worker sets `SaveTo = Host` and calls `EdsSetCapacity`. It
does not force image quality; the operator can do that from the Camera tab.

`EdsdkSource.capture()` keeps the existing `CaptureResult` contract. It picks
`canon-<uuid>.jpg` in `destDir`, calls the worker, then reads the dimensions with
sharp, exactly as `CanonTetheredSource` does today.

## Pre-focus during the countdown

- **Kiosk.** When the countdown reaches 1.5 s, `GetReady` calls
  `POST /camera/prefocus`. It is fire-and-forget: a failure is ignored, and the
  countdown never waits for it.
- **Agent.** `CameraManager.prefocus()` forwards the call to the active source.
  The call is optional on `CameraSource`, so the webcam and digiCamControl
  sources don't implement it.
- **Worker.** It sends `PressShutterButton Halfway` and holds it. In AI Servo the
  camera keeps tracking while the button is held.
  - If the half-press returns 8D01, it releases right away. The next capture
    then presses normally and falls back to non-AF if needed.
  - If no capture arrives within **3 s**, the worker releases (OFF) by itself.
    This covers a guest who taps ✕, and a kiosk that went away.
- Pre-focus is only an optimisation. Capture works the same whether or not
  pre-focus ran or failed.

## Live view

- `getLiveviewFrame()` returns the latest `EdsDownloadEvfImage` JPEG, or `null`.
  `EDS_ERR_OBJECT_NOTREADY` (0xA102) counts as `null`.
- The first frame request enables live view (`Evf_OutputDevice |= PC`). The
  first frame arrives about 0.5 s later.
- After **10 s** with no frame request, the worker turns live view off again
  (clears the PC bit) to save heat and battery.
- The agent's existing `/liveview` MJPEG route is unchanged, so the kiosk needs
  no change for live view.

## Connection, reconnect and supervision

- **Connect.** The worker scans `EdsGetCameraList` every 1 s until it finds a
  camera. Then it opens a session, registers the object, property and state
  handlers, applies the saved camera settings (see below), and pushes
  `state: connected` with the model name.
- **Disconnect.** On `kEdsStateEvent_Shutdown`, or when a command fails with a
  communication or device-not-found error, the worker closes the session,
  releases the camera ref, pushes `state: disconnected` and goes back to
  scanning.
  - Whether `EdsGetCameraList` in a long-lived process sees a re-plugged camera
    hasn't been tested yet. If it doesn't, the worker calls
    `EdsTerminateSDK` + `EdsInitializeSDK` before each scan. Implementation must
    test this live.
- **Keep-awake.** While connected, the worker sends
  `kEdsCameraCommand_ExtendShutDownTimer` every 60 s, so the R100's auto
  power-off never fires during an event.
- **Supervision.** `EdsdkSource` pings the worker every 2 s.
  - After two missed pings, or an exit, it kills the worker and respawns it,
    with a 1 s / 2 s / 5 s backoff (capped at 5 s).
  - While the worker is down, `isHealthy()` is false, so `CameraManager` falls
    back to the webcam exactly as it does today.
- **Timeouts.** Capture 12 s, frame 2 s, everything else 3 s. A timed-out
  request rejects. It does not kill the worker by itself; the pings decide that.
- **Shutdown.** `shutdown()` sends `shutdown`. The worker releases the shutter,
  closes the session, calls `EdsTerminateSDK` and exits. `EdsdkSource`
  force-kills it if it's still running after 3 s.
- **Conflict.** In EDSDK mode, preflight adds the check
  `canon.digiCamControlConflict`, which warns if `CameraControl.exe` is running.
  Both programs can't hold the camera at once.
- **Logs.** Worker `log` events are written through the agent's logger under the
  `camera:edsdk` tag, so they end up in the existing daemon log files.

## Camera settings (operator panel)

### Settable properties

| Setting | EDSDK property |
|---|---|
| ISO | `kEdsPropID_ISOSpeed` |
| Aperture | `kEdsPropID_Av` |
| Shutter speed | `kEdsPropID_Tv` |
| White balance | `kEdsPropID_WhiteBalance` |
| Exposure compensation | `kEdsPropID_ExposureCompensation` |
| Image quality | `kEdsPropID_ImageQuality` |

`kEdsPropID_AEMode` is read-only, because the R100's mode dial is physical.

- The options come from `EdsGetPropertyDesc`, so the panel only offers values
  the camera accepts in its current mode.
- A property whose description comes back empty is shown disabled. For example,
  Tv is disabled in Av mode.
- The worker keeps a small table that maps raw EDSDK codes to labels such as
  "1/125", "f/5.6" and "ISO 400". Codes missing from the table show as hex.

### Persistence

- Changed values are saved to `<dataDir>/camera.json`, next to `session.json`.
- On every (re)connect the worker re-applies the saved values. Values the camera
  rejects in its current mode are skipped and logged.
- "Use camera's current settings" deletes `camera.json`.

### API

All routes are GET or POST, to fit the existing CORS allowlist, and all use the
existing bearer auth.

| Route | What it does |
|---|---|
| `GET /camera/settings` | `{ connected, mode, values: {iso, av, tv, wb, ev, quality}, options: {...}, saved: {...} }` |
| `POST /camera/settings` | Takes a partial `{ iso?, av?, tv?, wb?, ev?, quality? }`, applies it, saves it, and returns the same shape as GET |
| `POST /camera/settings/reset` | Deletes `camera.json` |
| `POST /camera/test-shot` | Captures to a temp file and returns it as `image/jpeg`, then deletes it. No capture row, no print, no sync |
| `POST /camera/prefocus` | Returns 202 whatever happens |

When the source isn't EDSDK or no camera is connected, the settings routes
return 409 with a message the panel shows.

### Kiosk

A **Camera** tab in the operator panel, next to Status and Settings, shows:

- a small live view;
- the mode dial position;
- a select for each setting, whose change applies immediately;
- a **Test shot** button that shows the returned JPEG; and
- a **Use camera's current settings** button.

## Camera status

`/health` `camera` gains:

- `driver`
- `battery`: a percentage, or `"ac"`
- `mode`
- `afMode`
- `quality`
- `lastError`: a message and a timestamp. For example, "autofocus failed, took
  the shot without autofocus".

New alerts:

| Code | When |
|---|---|
| `camera-battery-low` | battery below 20%, not on AC |
| `camera-raw-only` | the quality setting produces no JPEG |
| `camera-digicamcontrol-conflict` | `CameraControl.exe` is running while the driver is EDSDK |

The operator panel's Status tab shows these fields.

## Testing

### Unit tests (vitest, run in CI on Ubuntu and Windows)

**Worker logic, against a fake `EdsApi`:**

- The press is always followed by OFF, both on success and on error.
- On 8D01 the worker releases the button, retries with `Completely_NonAF`, then
  releases again.
- On 0x81 it releases the button, waits 500 ms, retries once and releases again.
- A pre-focus half-press is held; a capture during the hold presses fully; with
  no capture, it is released after 3 s.
- Live view turns on at the first frame request and off after 10 s idle;
  NOTREADY returns `null`.
- A non-JPEG transfer is cancelled; with no JPEG the capture fails after 10 s.
- Disconnect and reconnect: on shutdown the state goes to disconnected, the
  worker rescans, and the saved settings are re-applied on connect.
- The settings code-to-label mapping; a value the camera rejects is skipped.

**EdsdkSource, against a fake worker that talks over the IPC:**

- Each request times out on its own.
- Two missed pings trigger a respawn with backoff.
- Frames return `null` while a capture is running.
- `isHealthy()` follows the pushed state.

CI has neither a camera nor the DLL. The real `edsdk.ts` binding is only loaded
when the driver is `edsdk`, so the tests never load the DLL.

### Hardware checklist (on the booth, after each deploy)

1. A normal capture.
2. A capture with the lens covered: it takes a non-AF shot and the camera stays
   usable.
3. Unplug and replug the USB cable: the camera reconnects without a service
   restart.
4. Power-cycle the camera: it reconnects.
5. Kill the worker process: it respawns and the camera comes back.
6. A 30-minute soak, with live view on and one capture a minute: no disconnect
   and no overheating.
7. A full guest session with a print. This happens only with the user's OK,
   since it uses paper.

## Phases (one PR each)

| # | Content | Deploy |
|---|---|---|
| 0 | Revert PR #46 (the CaptureNoAf fallback) | agent restart |
| 1 | Worker, binding, protocol, EdsdkSource; capture, live view, AF recovery, reconnect, keep-awake, supervision, `driver` config, preflight conflict check. Default driver stays `digicamcontrol` | agent restart; switch the config to `edsdk` on the booth once the 64-bit DLL is installed |
| 2 | Pre-focus: agent route plus the kiosk countdown hook | agent restart, then the kiosk deploy |
| 3 | Camera status fields and alerts; Status tab | agent restart, then the kiosk deploy |
| 4 | Camera tab: settings, test shot, persistence | agent restart, then the kiosk deploy |
| 5 | Delete `CanonTetheredSource` and the digiCamControl config; default `driver` to `edsdk`; update the README and preflight | agent restart |

Phase 1 code and tests can merge before the official SDK arrives, because the
default driver doesn't change. Live verification of phase 1 waits for the
64-bit DLL.

If Canon's approval takes too long, there is a stopgap: run the worker under a
32-bit Node, with koffi's ia32 build, against the 32-bit DLL. This is for
testing only and is not part of the design.

## Out of scope

- RAW capture or RAW download.
- Controlling the mode dial, zoom, or lens focus position (MF distance).
- Cameras from other brands, and more than one camera at once.
- Canon CCAPI (Wi-Fi control).
- Video, and GIF or boomerang capture.
