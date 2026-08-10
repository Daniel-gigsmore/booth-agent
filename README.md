# booth-agent

Local Windows service that owns the photobooth's camera and printer and exposes them to the kiosk (React) UI over `http://127.0.0.1:7070`. Runs entirely offline; the only thing that needs the internet is the background sync worker pushing finished captures up to Supabase.

## Contents

- [Architecture](#architecture)
- [Canon control: why digiCamControl, not EDSDK](#canon-control-why-digicamcontrol-not-edsdk)
- [Setup](#setup)
- [DNP Hot Folder Print setup](#dnp-hot-folder-print-setup)
- [Running](#running)
- [Installing as a Windows service](#installing-as-a-windows-service)
- [Configuration reference](#configuration-reference)
- [API](#api)
- [Testing the acceptance criteria](#testing-the-acceptance-criteria)
- [Known limitations](#known-limitations)

## Architecture

```
kiosk UI (browser, same PC)
   │  HTTP + WebSocket, 127.0.0.1:7070, Bearer <sharedSecret>
   ▼
booth-agent
   ├─ CameraManager           picks Canon or webcam, polls health, auto fallback/recover
   │   ├─ CanonTetheredSource     shells out to digiCamControl
   │   └─ WebcamSource            shells out to ffmpeg (dshow)
   ├─ compositor (sharp)      template overlay, 4x6 / 2x6-strip layout, 300dpi JPEG
   ├─ SQLite outbox           every capture written to disk+DB before anything else happens
   │   └─ SyncWorker              background push to Supabase Storage + Postgres, exp backoff
   ├─ PrintQueue               fire-and-forget drop into the DNP hot folder, ordered
   └─ EventBus → WebSocket /events
```

Nothing here is multi-tenant; it's wired to one event (`event.id` in config) at a time. The agent never talks to an AI provider directly - `/composite` can pull an already-generated AI image back down from a URL (produced by the existing Supabase `transform-image` Edge Function) but that's a plain file download, not an AI call.

### Camera adapter pattern

`CameraSource` (`src/camera/CameraSource.ts`) is the only contract the rest of the app depends on: `initialize`, `isHealthy`, `capture`, `getLiveviewFrame`, `getModel`. `CanonTetheredSource` and `WebcamSource` are the two implementations. Adding a third camera later means writing one new class against that interface and registering it in `CameraManager`'s source map in `src/index.ts` - nothing else changes.

`CameraManager` polls both sources' health every 500ms. If the active source fails two consecutive polls (~1s, well under the 3s SLA) it switches to whichever other source is healthy and emits `camera-fallback` + `camera-disconnected`. When the preferred source comes back healthy for two consecutive polls, it switches back automatically and emits `camera-fallback` again - no restart involved. A capture call that fails mid-flight (e.g. Canon unplugged between the health poll and the shutter) is retried once on the fallback source before giving up, so `/capture` itself never has to fail just because one device dropped out.

### Reliability (SQLite outbox)

A capture is durable the instant the file lands on disk: `POST /capture` writes the JPEG, then inserts a row into `data/outbox.db` (`sync_status = 'pending'`) *before* responding. Nothing about printing or the UI depends on the network. A background `SyncWorker` polls for due rows, uploads the print-ready (or original) file to Supabase Storage and upserts the `captures` row, and on failure reschedules with exponential backoff (`sync.initialBackoffMs` → `sync.maxBackoffMs`, capped multiplier `sync.backoffMultiplier`). Uploads are idempotent: the storage object key and the Postgres upsert are both keyed on the capture's local UUID, so a retry after a crash overwrites the same object/row instead of duplicating it. On startup, any row left in `'uploading'` from a previous crash is reset to `'pending'` and retried - see `OutboxStore.resetStuckUploads()`.

booth-agent uses Node's **built-in `node:sqlite`** module rather than `better-sqlite3` or any other native npm package. That was a deliberate choice: `better-sqlite3` needs a native addon compiled against the exact Node ABI (Visual Studio Build Tools + Windows SDK on the machine), which is one more thing that can silently break when the mini-PC's Node version changes or a rebuild happens without full build tools installed. `node:sqlite` ships inside Node itself - zero native compilation, zero ABI risk. It requires **Node 22.5+**.

### Printing

`POST /print` never touches the disk itself synchronously - it validates the capture has been composited, records the job, and returns a queue position immediately. The actual file copy into the DNP hot folder happens on an internally serialized promise chain, so five `/print` calls fired back to back all return instantly and still land in the hot folder in the order they were requested. There is no printer driver integration in this codebase; the DNP DS-RX1HS's own **Hot Folder Print** utility is the thing that actually talks to the printer.

## Canon control: why digiCamControl, not EDSDK

Canon's own EDSDK is a native C SDK. Using it from Node means maintaining a compiled N-API/FFI addon, tying the agent to a specific Canon developer-program agreement, and rebuilding that binary on every Node/Windows update - a lot of fragile surface area for a single in-house booth with one person maintaining it.

Instead, `CanonTetheredSource` (`src/camera/CanonTetheredSource.ts`) drives the R100 through **[digiCamControl](https://digicamcontrol.com/)**, a free, actively maintained Windows app with broad EOS support, via two of its stable remote-control surfaces. This has been verified against a real tethered R100 and digiCamControl 2.1.7.0 (an earlier draft of this doc guessed at the command syntax before that test; what's below is what actually works):

1. **`CameraControlRemoteCmd.exe`** (ships with digiCamControl) - a small CLI that talks to an already-running `CameraControl.exe` (the digiCamControl GUI) session over local IPC.
   - **Capture** is three separate commands, each returning immediately - the shutter + USB transfer happens asynchronously in the GUI process, so `capture()` polls the destination folder for the file rather than treating the command's own return as "done":
     ```
     CameraControlRemoteCmd.exe /c "set session.folder <dir>"
     CameraControlRemoteCmd.exe /c "set session.filenametemplate <name>"
     CameraControlRemoteCmd.exe /c Capture
     ```
     The result lands at `<dir>\<name>.jpg`. Run `CameraControlRemoteCmd.exe /c "list cmds"` against your build to confirm `Capture` is still the right verb - it's case-sensitive and there is **no** "list connected cameras" command in this CLI (an earlier version of this doc assumed one).
   - **Connection/health checks** don't go through the CLI at all, and - after a live test caught this the hard way - they don't come from the GUI's window title either. The window title looked like a clean signal (`digiCamControl - <model> (<serial>)` once connected) and an earlier version of this agent used it, until testing showed it going stale: it sat on the no-camera state while the R100 was genuinely connected and successfully taking pictures through the GUI. What's actually reliable is digiCamControl's own event log at `C:\ProgramData\digiCamControl\Log\app.log`, which logs an unambiguous `===========Camera is connected==============` / `...disconnected==============` line on every real state change. `isHealthy()` tails that file (only the bytes appended since the last check, so cost doesn't grow with the log's total size over a multi-hour event) and separately confirms the `CameraControl.exe` process is still running at all, since a killed process produces no further log lines to tail. `getModel()` reads the `Name :<model>` line that follows a connect event in the same log.
2. **The WebServer plugin** (`digiCamControl` → Settings → WebServer, default port `5513`) - serves the current live-view frame as a plain JPEG at `GET /liveview.jpg`, which the agent polls for the MJPEG preview stream. (Not yet verified live against real hardware - unlike the capture/health-check path above, this is still the original documented behavior, untested.)

All of this is isolated behind `CanonTetheredSource` - the rest of the app has no idea digiCamControl exists.

**Before going live**, re-verify `CameraControlRemoteCmd.exe /c "list cmds"` and the app log's path/line format against your installed build if you're on a different digiCamControl version - both have already drifted/surprised once each, and the relevant code is entirely inside `CanonTetheredSource.ts`.

**Setup:**
1. Install digiCamControl on the mini-PC and confirm it can see the R100 tethered over USB - launch `CameraControl.exe` once and check its window title picks up the camera model.
2. Settings → WebServer → enable, port `5513` (or your choice - update `capture.canon.digiCamControlHttpPort` in config to match).
3. Leave `CameraControl.exe` running (it can run minimized) - `CameraControlRemoteCmd.exe` needs a live session to talk to.
4. Set `capture.canon.digiCamControlExePath` in `booth.config.json` to the full path of `CameraControlRemoteCmd.exe` (typically `C:\Program Files (x86)\digiCamControl\CameraControlRemoteCmd.exe`).

## Setup

Requirements on the booth PC:
- **Node.js 22.5+** (for `node:sqlite`)
- **ffmpeg** on `PATH` (or set `capture.webcam.ffmpegPath` to a full path) - used for the webcam fallback
- **digiCamControl** installed and running - used for the Canon path
- **DNP Hot Folder Print** utility installed - see below

```powershell
git clone <this repo>   # or copy the folder onto the mini-PC
cd booth-agent
npm install
copy booth.config.example.json booth.config.json
notepad booth.config.json   # fill in paths, Supabase URL/key, event id, shared secret
npm run build
```

## DNP Hot Folder Print setup

DNP's **Hot Folder Print (HFP)** utility watches folders and prints whatever image lands in them; each watched folder is tied to a Windows printer queue and named after the output size it produces (DNP's own docs give `4 x 6`, `5 x 7`, `6 x 8`, etc. as examples). Because print size is a property of *which folder/queue* a file lands in, not something encodable in a filename, the agent uses **one subfolder per print size** under the configured `printing.hotFolderPath`:

```
<hotFolderPath>/4x6/
<hotFolderPath>/2x6-strip/
```

**How the 2x6 strip actually gets cut.** The DS-RX1HS's strip-cutting is a *printer driver* feature, not an HFP folder setting: the driver can cut a printed 4x6 sheet into two separate 2x6 strips automatically ("2 inch cut"). Since `/composite` already renders the full 4x6 sheet with both strips pre-laid-out side by side (per the acceptance criteria), the agent's job is just to get that sheet cut in half - so `2x6-strip` should route to a printer queue with the driver's cutter enabled, while `4x6` must route to one with it disabled (otherwise a real single-photo 4x6 print gets sliced in two).

Setup:
1. Install DNP Hot Folder Print and confirm it can print a test image to the DS-RX1HS directly (outside the agent) first.
2. In **Control Panel → Devices and Printers**, add the DS-RX1HS a **second time** (same driver/port, different queue name - e.g. "DNP DS-RX1HS - Strip Cut") so you have two independent printer queues for the one physical printer:
   - queue 1 (e.g. "DNP DS-RX1HS"): default settings, cutter **disabled** - used for whole 4x6 photos.
   - queue 2 ("...- Strip Cut"): right-click → **Printing Preferences → Advanced/Layout tab** → Paper Size **`PR (4x6)`** (the portrait-safe 4x6 variant) → Printer Features → **"2 inch cut" → Enable**. Requires printer firmware **1.10+** and driver **1.1.0.0+** - check `Printing Preferences → About`/firmware page and update if older.
3. In Hot Folder Print, create **two** watched-folder profiles: one pointed at `<hotFolderPath>\4x6` targeting queue 1, one pointed at `<hotFolderPath>\2x6-strip` targeting queue 2.
4. Set `printing.hotFolderPath` in `booth.config.json` to the parent folder (e.g. `C:\BoothAgent\hotfolder`) - the agent creates the two subfolders itself on first print.
5. Confirm both Hot Folder Print profiles are running (they usually start with Windows, or start them alongside the tray app).
6. Print one real test job through each folder before the event - confirm the `2x6-strip` folder actually comes out as two separated strips, not one uncut sheet.

`GET /health` reports `hotFolder.writable`, checked against the parent `hotFolderPath` (a Denied-permission or full/disconnected drive shows up there immediately).

Sources for the driver-level cutter behavior (Hot Folder Print's own per-folder UI wasn't independently confirmed, since I don't have the installed utility in front of me - verify step 3 against your actual HFP version before the event):
- [DNP's Hot Folder Print product page](https://www.dnpphoto.com/hot-folder-print) - folder-per-output-size naming, "2x6\" prints for photo booth style prints" as a listed feature
- [Imaging Spectrum: How to print 2x6 photo booth strips with a DNP DS40 or DNP RX1](https://imagingspectrum.com/blogs/blog/how-to-print-2x6-photo-booth-strips-with-a-dnp-ds40-or-dnp-rx1-photo-printer) - Paper Size `PR (4x6)` + "2 inch cut" enable steps
- [Imaging Spectrum: 2x6 Photo Strips added to DNP DSRX1](https://imagingspectrum.com/blogs/blog/photobooth-2x6-strips-added-to-dnp-dsrx1-photo-printer) - firmware 1.10+ / driver 1.1.0.0+ requirement

## Running

**Dev / interactive** (console output, restarts on file change):
```powershell
.\install\run-dev.ps1
```

**Production** (after `npm run build`):
```powershell
node dist\index.js
```
or install it as a Windows service (below), which is what an actual booth deployment should use.

**Optional tray icon** (status only - polls `/health`, does not run the agent):
```powershell
.\install\start-tray.ps1
```
Green = camera connected on the preferred source, hot folder writable, outbox healthy. Amber = running on the fallback camera and/or the outbox has a recent error. Red = no camera or an unwritable hot folder. Quitting the tray does **not** stop the service.

## Installing as a Windows service

From an elevated PowerShell prompt:
```powershell
npm install
npm run build
.\install\install-service.ps1
```
This registers a service named `BoothAgent` (via `node-windows`, which wraps `sc.exe`) that runs `node dist\index.js`, starts on boot, and restarts on crash. Check it with `Get-Service BoothAgent` or `services.msc`.

To remove it:
```powershell
.\install\uninstall-service.ps1
```

## Configuration reference

See `booth.config.example.json` for the full shape (validated by `src/config/schema.ts` on load and on every edit). Highlights:

| Key | Meaning |
|---|---|
| `agent.sharedSecret` | Required on every request as `Authorization: Bearer <secret>` (or `?token=` for `<img>`/WS clients that can't set headers). Loopback binding is the real security boundary; this just stops other local processes from poking the agent by accident. |
| `capture.sourcePreference` | `"canon"` or `"webcam"` - which one the manager prefers when both are healthy. |
| `printing.hotFolderPath` | Parent folder; `4x6/` and `2x6-strip/` subfolders are created under it (see above). |
| `compositing.templateDir` | Where `<templateId>.json` template files and their overlay PNGs live. See `assets/templates/default.json` (4x6) and `assets/templates/default-strip.json` (2x6-strip, 3 stacked photo slots) for the shape. |
| `event.id` | The single event this deployment is wired to (single-tenant). |

`booth.config.json` is watched for changes and re-validated on save; `capture.sourcePreference` takes effect immediately without a restart. Other fields (ports, paths) require a restart since they're read once at startup by things like the HTTP listener and DB connection.

## API

All endpoints require `Authorization: Bearer <sharedSecret>` (or `?token=`).

- `GET /health` - camera (active source, model, both sources' connection state), hot folder writability, disk free/total, outbox queue depth/last sync/last error.
- `GET /liveview` - MJPEG multipart stream (`multipart/x-mixed-replace`), Canon live view when active, webcam otherwise.
- `POST /capture` - triggers a capture on the active source. Returns `{ captureId, filePath, width, height, source, takenAt }`.
- `POST /composite` - body `{ captureId, templateId, printSize?, aiOutputUrl? }`. Applies the named template; if `aiOutputUrl` is given, downloads that image first and composites from it instead of the original capture (this is the "AI output pulled back down from Supabase" path). Returns the print-ready file path.
- `POST /print` - body `{ captureId, size? }`. Requires the capture to have been composited first. Returns `{ jobId, queuePosition, estimatedWaitMs }` immediately.
- `GET /print/queue` - pending jobs with live-recomputed queue position and estimated wait (`secondsPerPrint` × position).
- `WS /events` - `capture-taken`, `sync-status`, `print-queued`, `print-completed`, `camera-disconnected`, `camera-fallback`, `camera-recovered`, `error`. Connect with `ws://127.0.0.1:7070/events?token=<sharedSecret>`.

## Testing the acceptance criteria

Run `npm test` first for the automated coverage (outbox sync worker offline→online behavior, 2x6 strip compositor output, camera fallback/recovery timing) - `npm run build` then `npm test` (or `npm run test:watch`). The rest below are manual, on the real hardware.

**Canon unplug/replug fallback**
1. Start the agent with `capture.sourcePreference: "canon"`, Canon tethered and digiCamControl running.
2. Confirm `GET /health` shows `camera.activeSource: "canon"`.
3. Unplug the USB cable. Within ~3 seconds, `/health` should show `activeSource: "webcam"` and a `camera-fallback` event should arrive on `/events`.
4. `POST /capture` should still succeed (now via webcam).
5. Replug the Canon. Within a couple of seconds `/health` should show `activeSource: "canon"` again, with another `camera-fallback` event - no restart needed.

**Offline capture/print/reconnect (no data loss)**
1. Disconnect the mini-PC from the network (or block the Supabase host).
2. Take 20 captures via `/capture`, `/composite`, `/print` for each.
3. Confirm all 20 land in the correct hot-folder subfolder in order and print.
4. Check `/health`: `outbox.queueDepth` should be 20, `lastError` set.
5. Reconnect the network. Watch `/events` for `sync-status` - queue depth should drain to 0 with no errors.
6. In Supabase, confirm exactly 20 rows/objects exist for that event - no duplicates.

**Non-blocking print queue**
1. With a valid composited capture, fire 5 `POST /print` calls back to back (e.g. a small script with no `await` between them, or 5 curl calls in the background).
2. Each call should return in well under a second with an incrementing `queuePosition`.
3. Confirm all 5 files appear in the hot folder in request order (check file creation timestamps or add a numbered suffix on the client side before printing).

**2x6 strip layout**
1. `POST /composite` with `printSize: "2x6-strip"` and `templateId: "default-strip"`.
2. Open the output file: it must be a single 1200×1800px (4in×6in @300dpi) image. The left half (0-600px) and right half (600-1200px) should be visually identical strips, right-side up.
3. `npm test` also covers this pixel-for-pixel (`tests/compositor.strip.test.ts`).

**`/health` accuracy**
- Full disk: fill the data volume (or point `storage.dataDir` at a near-full drive) and confirm `disk.freeBytes` reflects it.
- Unwritable hot folder: point `printing.hotFolderPath` at a read-only location (or revoke write ACLs) and confirm `hotFolder.writable: false`.
- Disconnected camera: unplug both the Canon and any webcam; confirm `camera.activeSource: "none"` and `POST /capture` returns `503`.

**Crash/restart resumption**
1. Take several captures while offline so they queue up.
2. Kill the agent process (or `Stop-Service BoothAgent`) mid-sync.
3. Restart it. `SyncWorker` resets anything stuck in `'uploading'` back to `'pending'` on startup (`OutboxStore.resetStuckUploads()`) and resumes - confirm nothing duplicates in Supabase and nothing gets lost (`outbox.queueDepth` eventually reaches 0).

**Loopback-only binding**
```powershell
netstat -ano | findstr :7070
```
Every line must show `127.0.0.1:7070`, never `0.0.0.0:7070`.

## Known limitations

- **Webcam live view frame rate is low.** `WebcamSource.getLiveviewFrame()` spawns a fresh `ffmpeg` process per frame (no disk round-trip, but no persistent stream either), which caps preview smoothness to a few fps. Fine for a booth preview; if a smoother webcam live view is needed later, replace it with a persistent `ffmpeg` process demuxing an MJPEG stream and parsing frame boundaries, still entirely inside `WebcamSource.ts`.
- **digiCamControl CLI flags may need adjusting per version** - see the callout above.
- **Supabase `captures` table column mapping is a best guess.** `src/supabase/supabaseClient.ts`'s `toCaptureRecord()` was written to a plausible schema without direct access to the live Supabase project from this environment. Verify/adjust the column names there against the real table before go-live - it's the only function that needs to change.
