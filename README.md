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
2. **The WebServer plugin** (`digiCamControl` → Settings → WebServer, default port `5513`) - serves the current live-view frame as a plain JPEG at `GET /liveview.jpg`, which the agent polls for the MJPEG preview stream. Verified live against a real R100, and this surfaced two real bugs, both fixed in `CanonTetheredSource.ts`:
   - Enabling the WebServer plugin alone isn't enough - `/liveview.jpg` returns `HTTP 200` with an empty body until digiCamControl's live view has actually been started at least once per digiCamControl session, which has no dedicated verb in `CameraControlRemoteCmd.exe` - the only way to trigger it is a plain `GET /liveview.html?CMD=LiveViewWnd_Show` on the same WebServer port (what clicking "Live" in digiCamControl's own web remote does under the hood). `getLiveviewFrame()` now does this automatically: whenever a poll comes back empty, it fires that request once and retries the fetch, so a booth operator never needs to know this URL exists. This is genuinely self-healing across a camera disconnect/reconnect too, not just first startup.
   - Separately, `getLiveviewFrame()` used to gate on a private `initialized` flag set exactly once, by the *first* `initialize()` call at agent startup. If that first call happened before digiCamControl/the camera were ready, the flag latched `false` for the rest of the process's life - live view stayed permanently broken even after `/health` correctly reported the camera reconnected, until the whole agent process was restarted. Fixed by dropping that flag entirely; the method now just attempts the fetch every time, the same pattern `capture()` already used, relying on the same live `CameraManager.active` gate the caller already checks.
   - Confirmed live: killed and relaunched digiCamControl mid-session (forcing a real disconnect/reconnect) *without* restarting the agent and without manually hitting the start-live-view URL - the MJPEG stream recovered entirely on its own, where before these fixes it either stayed permanently broken or required a manual trigger. One caveat from testing worth knowing about but not code-fixable: Canon's EDSDK can return a transient `Device Busy` error on `StartLiveView()` if the *previous* digiCamControl process wasn't shut down cleanly (e.g. force-killed) - normal single restarts don't trigger this, but if live view seems stuck, a power cycle of the camera clears it.

All of this is isolated behind `CanonTetheredSource` - the rest of the app has no idea digiCamControl exists.

**Before going live**, re-verify `CameraControlRemoteCmd.exe /c "list cmds"` and the app log's path/line format against your installed build if you're on a different digiCamControl version - both have already drifted/surprised once each, and the relevant code is entirely inside `CanonTetheredSource.ts`.

**Setup:**
1. Install digiCamControl on the mini-PC and confirm it can see the R100 tethered over USB - launch `CameraControl.exe` once and check its window title picks up the camera model.
2. Settings → WebServer → enable, port `5513` (or your choice - update `capture.canon.digiCamControlHttpPort` in config to match). Restart `CameraControl.exe` for the setting to take effect.
3. Leave `CameraControl.exe` running (it can run minimized) - `CameraControlRemoteCmd.exe` needs a live session to talk to. No manual live-view step needed - the agent starts it automatically (see above).
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

This section was rewritten after installing the actual utility and running real prints through it end to end (agent `/capture` → `/composite` → `/print` → physical DS-RX1HS output) - the previous version of this doc guessed at a driver-queue-based setup that turned out not to match how the software actually works. Everything below is verified, not inferred from generic docs.

**What you're installing.** The current DNP Hot Folder Print (v3.6.37 at time of writing) is a modern rewrite - a Blazor/WebView2-based app, not the older classic utility most third-party writeups describe. Get it from DNP's official downloads page ([dnpphoto.com/hot-folder-print](https://www.dnpphoto.com/hot-folder-print) → downloads search), not a third-party mirror. It installs to a fixed location, `C:\DNP\HotFolderPrint\`, not Program Files.

**It does not take an arbitrary watched folder.** Unlike what DNP's own generic documentation and older versions suggest, this version watches a **fixed set of folders under its own install directory** - there's no "point it at any folder you like" option that actually took effect in testing. The relevant ones, confirmed live by dropping a real file in and watching `Logs\log-<date>.txt` record it being picked up, cropped, and sent to the printer:

```
C:\DNP\HotFolderPrint\Prints\s4x6\    - whole 4x6 photo, printed uncut
C:\DNP\HotFolderPrint\Prints\s6x2_2\  - a 4x6 sheet with the cutter engaged,
                                         producing two separate 2x6 strips
```

`s6x2_2` is the one that matters for `printSize: "2x6-strip"`: the compositor already renders the full two-up 4x6 sheet (two identical strips side by side per the acceptance criteria), and dropping that into `s6x2_2` gets the physical cutter to separate it into two individual strips automatically - confirmed on real paper. `s4x6` prints the sheet as-is.

These `s...` names are this rewrite's own internal scheme, not a documented public API, and are exactly the kind of thing to re-verify if you're on a different HFP version - the mapping lives in one place, `hotFolderPathFor()` in `src/print/hotFolder.ts`.

**Setup:**
1. Install DNP Hot Folder Print from the official downloads page. The installer can silently succeed while looking stuck on a repeat launch - if `msiexec` seems hung, check whether it actually already installed via `Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* | Where DisplayName -match HotFolder` before assuming it's frozen.
2. Launch `C:\DNP\HotFolderPrint\HotFolderPrint.exe` once and confirm it sees the printer - check `C:\DNP\HotFolderPrint\Logs\printer_status.txt`, which should show `"Status": "STATUS_OK"` and the right model.
3. Set `printing.hotFolderPath` in `booth.config.json` to `C:\DNP\HotFolderPrint\Prints` - the agent writes into the `s4x6`/`s6x2_2` subfolders itself, it doesn't need them pre-created.
4. Leave `HotFolderPrint.exe` running (start it alongside the tray app, or add it to Windows startup) - like digiCamControl, it needs to be alive to pick anything up.
5. Print one real test job through each size before the event - confirm `s6x2_2` actually comes out as two separated strips, not one uncut sheet.

**Offline behavior - tested, not just assumed.** This version phones home on startup and periodically (`app-shieldv2-prod.azurewebsites.net`, `dnpphoto.com`) and logs occasional `Lost connection.... The system will reconnect automatically.` messages, which looked like a real risk for an agent whose entire premise is working with the venue's internet down. Tested directly: disabled the network adapter, waited 90s, dropped a real composite into `s4x6`, and HFP picked it up, cropped it, and sent it to the printer in about 3 seconds - still fully offline - with a physical print confirmed correct. The Shield/telemetry connection is decorative as far as printing is concerned; it reconnects and resumes its pings once the network comes back, but core hot-folder printing doesn't wait on it.

`GET /health` reports `hotFolder.writable`, checked against the configured `hotFolderPath` root (a denied-permission or full/disconnected drive shows up there immediately).

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
Green = camera connected on the preferred source, hot folder writable, outbox healthy. Amber = running on the fallback camera and/or the outbox has a recent error. Red = no camera or an unwritable hot folder. Quitting the tray does **not** stop the service. **The status icon/tooltip is reliable; the menu's click actions are not** - see [Known limitations](#known-limitations).

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
| `printing.hotFolderPath` | HFP's `Prints` folder (typically `C:\DNP\HotFolderPrint\Prints`); the agent writes into its `s4x6`/`s6x2_2` subfolders (see above). |
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
- **digiCamControl and Hot Folder Print's exact commands/folder names are version-pinned, not documented public APIs.** Both were verified live (digiCamControl 2.1.7.0, Hot Folder Print 3.6.37) against real hardware, and both already turned out to differ from what generic vendor docs describe. Re-verify against your installed versions if either changes - see the callouts in the Canon and DNP sections above for exactly how.
- **Supabase `captures` table column mapping is still a best guess** - `toCaptureRecord()` in `src/supabase/supabaseClient.ts` was written to a plausible schema without direct access to the real production project. What *is* verified: the upload mechanics themselves. Tested end to end against a real local Supabase stack (Postgres + Storage, via `supabase start`/Docker) - upload, Postgres upsert, and the crash-and-retry path all confirmed idempotent (no duplicate rows or storage objects) by querying Postgres and re-downloading the uploaded file directly, not just trusting the client library's return value. That test also surfaced a real prerequisite: an anon-key client needs explicit `GRANT`s on the `captures` table and RLS policies on `storage.objects` scoped to the bucket - including an **UPDATE** policy, not just INSERT, since a retried `upsert: true` write to an existing key is an update as far as RLS is concerned (denying it produces the same error message as a missing INSERT policy). See the comment above `toCaptureRecord()` for the exact grants/policies. If the real project already has a working booth UI, these almost certainly already exist - verify, don't assume.
- **Tray icon menu clicks ("Open Data Folder", "Quit tray") are unreliable.** The status icon and tooltip are confirmed accurate (color/text verified live against a running agent). The click handlers are a different story: isolated testing against the underlying `systray2` package (with a direct synchronous file write inside the click handler, to rule out any logging/buffering artifact) showed clicks failing to register across three different scenarios - the original code, a fix that keeps menu item objects stable across updates instead of replacing them each poll (present in this codebase, since it's a real improvement over recreating them), and even a completely pristine menu that had never received a single update. That last case rules out menu-update frequency as the cause, which means this is very likely an issue in `systray2`'s native Windows tray binary itself (`tray_windows_release.exe`), not in this app's code. Net effect: treat the tray as **status-only**. Don't rely on its menu actions - use `Get-Service` / the Windows service manager to stop the agent, and open the data directory from `booth.config.json`'s `storage.dataDir` directly instead of via the tray menu. If this needs to be fixed properly, the next step would be running the native binary in its debug protocol mode to inspect its raw stdout, or replacing `systray2` with a different tray library.
