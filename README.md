# booth-agent

Local Windows service that owns the photobooth's camera and printer and exposes them to the kiosk (React) UI over `http://127.0.0.1:7070`. Runs entirely offline; the only thing that needs the internet is the background sync worker pushing finished captures up to Supabase.

The guest-facing touchscreen UI lives in [`kiosk/`](kiosk/) (React + Vite). It is deployed to `C:\BoothAgent\kiosk` on the booth PC; see `kiosk/README.md`.

## Contents

- [Architecture](#architecture)
- [Canon control](#canon-control)
- [Nikon control](#nikon-control)
- [Setup](#setup)
- [DNP Hot Folder Print setup](#dnp-hot-folder-print-setup)
- [Supabase schema setup](#supabase-schema-setup)
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

Nothing here is multi-tenant; it works one event at a time: the active event in `<dataDir>/events.json`, which the kiosk's Events tab switches. The agent never talks to an AI provider directly - `/composite` can pull an already-generated AI image back down from a URL (produced by the existing Supabase `transform-image` Edge Function) but that's a plain file download, not an AI call.

### Camera adapter pattern

`CameraSource` (`src/camera/CameraSource.ts`) is the only contract the rest of the app depends on: `initialize`, `isHealthy`, `capture`, `getLiveviewFrame`, `getModel`. `CanonTetheredSource` and `WebcamSource` are the two implementations. Adding a third camera later means writing one new class against that interface and registering it in `CameraManager`'s source map in `src/index.ts` - nothing else changes.

`CameraManager` polls both sources' health every 500ms. If the active source fails two consecutive polls (~1s, well under the 3s SLA) it switches to whichever other source is healthy and emits `camera-fallback` + `camera-disconnected`. When the preferred source comes back healthy for two consecutive polls, it switches back automatically and emits `camera-fallback` again - no restart involved. A capture call that fails mid-flight (e.g. Canon unplugged between the health poll and the shutter) is retried once on the fallback source before giving up, so `/capture` itself never has to fail just because one device dropped out.

### Reliability (SQLite outbox)

A capture is durable the instant the file lands on disk: `POST /capture` writes the JPEG, then inserts a row into `data/outbox.db` (`sync_status = 'pending'`) *before* responding. Nothing about printing or the UI depends on the network. A background `SyncWorker` polls for due rows, uploads the composite (or original) file to Supabase Storage and upserts the `captures` row, and on failure reschedules with exponential backoff (`sync.initialBackoffMs` → `sync.maxBackoffMs`, capped multiplier `sync.backoffMultiplier`). Uploads are idempotent: the storage object key and the Postgres upsert are both keyed on the capture's local UUID, so a retry after a crash overwrites the same object/row instead of duplicating it. On startup, any row left in `'uploading'` from a previous crash is reset to `'pending'` and retried - see `OutboxStore.resetStuckUploads()`.

A row is finished when the file **currently** in Supabase Storage is the file we would send now, not when it has synced once. That distinction matters because `/capture` inserts the row and the sync worker can claim it within a tick or two - online, that is long before the guest has picked a template and `/composite` has produced the print-ready image. Tracking only `sync_status` meant the row was declared done at that moment, so on any capture taken with a working network the branded composite and its `print_size` never reached Supabase; only the raw original did. (It looked correct offline, which is the one ordering where compositing always finishes first.) `OutboxStore` now records `synced_source_path` - the local file that actually went up - and re-queues the row when it differs from `composite_path`. The storage key is unchanged between the two, so the second upload overwrites the same object rather than creating a duplicate.

Failures split two ways. Anything that could succeed later - the network being down, Supabase unreachable, a 5xx - retries forever with no attempt cap, because being offline for an entire event is a supported state and an attempt count would punish a perfectly healthy capture for a long outage. A failure that can never succeed by waiting (the local file is gone: `PermanentSyncError`) abandons the row instead, so it stops holding `queueDepth` above zero and pinning `lastError` to `/health` for the life of the deployment. Abandoned rows are reported as their own `/health` warning and listed at `GET /sync/abandoned`; `POST /sync/abandoned/retry` puts them all back in the queue once whatever made the files unreachable is fixed.

booth-agent uses Node's **built-in `node:sqlite`** module rather than `better-sqlite3` or any other native npm package. That was a deliberate choice: `better-sqlite3` needs a native addon compiled against the exact Node ABI (Visual Studio Build Tools + Windows SDK on the machine), which is one more thing that can silently break when the mini-PC's Node version changes or a rebuild happens without full build tools installed. `node:sqlite` ships inside Node itself - zero native compilation, zero ABI risk. It requires **Node 22.5+**.

### Printing

`POST /print` never touches the disk itself synchronously - it validates the capture has been composited, records the job, and returns a queue position immediately. The actual file copy into the DNP hot folder happens on an internally serialized promise chain, so five `/print` calls fired back to back all return instantly and still land in the hot folder in the order they were requested. There is no printer driver integration in this codebase; the DNP DS-RX1HS's own **Hot Folder Print** utility is the thing that actually talks to the printer.

## Canon control

### EDSDK driver (`capture.canon.driver: "edsdk"`)

The agent drives the R100 through Canon's EDSDK in its own child process (`src/camera/edsdk/`), instead of through digiCamControl. We switched because digiCamControl never releases the shutter button after a failed autofocus (`8D01`); the camera then answers `0x81` (busy) to everything until it is power-cycled. The worker always releases the shutter button, and on `8D01` it retakes the shot without autofocus. See `docs/superpowers/specs/2026-09-25-edsdk-camera-design.md`.

**Only works from the built `dist/`** (the Windows service, or `npm start`). `EdsdkSource` forks `dist/camera/edsdk/worker.js` next to its own compiled file; under `npm run dev` (ts-node-dev) that file doesn't exist, so the worker process exits immediately and the agent just keeps respawning it. Run `npm run build && npm start` to actually exercise this driver.

**Setup:**
1. Register with the Canon developer programme and download EDSDK. Copy the **64-bit** `EDSDK.dll` and `EdsImage.dll` into `C:\BoothAgent\edsdk\`. They're not in git: Canon's licence doesn't allow redistributing them. The 32-bit DLL that ships with digiCamControl won't load into 64-bit Node.
2. Install the worker's dependency (`koffi`) into the live checkout: stop the service (`Stop-Service boothagent` in an admin shell), run `npm ci` in the agent checkout, then start it again (`Start-Service boothagent`). A plain `git pull` + `npm run build` deploy never installs new dependencies, so skipping this leaves `koffi` missing - the worker process would crash-loop on `require("koffi")` while preflight still reports `canon.edsdkDll: ok` (that check only looks at the DLL, not the worker's own dependencies). Never run `npm ci` while the service is running.
3. Close digiCamControl and remove it from startup. Only one program can hold the camera, and preflight warns (`canon.digiCamControlConflict`) if both run.
4. Set `"driver": "edsdk"` under `capture.canon` in `booth.config.json`, then restart the service.
5. Check `/health/preflight`: `canon.edsdkDll` should be `ok`. Then check that `/health` shows `canonConnected: true`.

The worker reconnects on its own after a camera power-cycle or a USB replug. It keeps the camera awake while connected, turns live view on when the kiosk asks for frames, and turns it off again after 10 s without one. If the worker crashes or hangs, the agent restarts it; the webcam covers in the meantime.

### digiCamControl driver (legacy)

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

## Two cameras (high and low)

Only the `edsdk` driver supports a second camera. Both bodies must be R100s (or another EDSDK-supported model) - digiCamControl only ever drives one.

On first run, with two cameras plugged in, which one becomes "high" and which "low" is arbitrary - whichever the OS enumerates first. Fix that from the Camera tab (Swap/Remember), or directly via `POST /cameras/swap` and `POST /cameras/remember`, which write `<dataDir>/cameras.json` (the two cameras' serial numbers per slot) and restart both EDSDK workers against it.

Each slot keeps its own settings file, `camera-high.json` and `camera-low.json`, under the data dir. An existing single-camera `camera.json` is moved to `camera-high.json` automatically on first start after upgrading - no manual step needed.

A layout assigns a photo element to the low camera by setting `"camera": "low"` on it (the layout editor doesn't have a switch for this yet - that's PR 2). Anything else, and requests with no `camera` at all, still mean "high".

If the low camera is missing or disconnected, capture falls back low -> high -> webcam, same fallback order as a single camera missing high.

`GET /health` reports both cameras under `cameras: { high, low }`, and a missing low camera is `camera-low-none` - an error if the current layout actually uses it, and no alert otherwise.

Hardware verification of two simultaneous EDSDK sessions is pending a 64-bit `EDSDK.dll` for the second body. If two worker processes can't hold the SDK open at once, the fallback is running both cameras through one process instead (approach 2 in the design doc).

## Nikon control

The Nikon Z 30 is driven through Nikon's **Remote SDK v2** (`S-SDKZ-200BF-ALLIN`) in its own worker process (`src/camera/nikon/`), the same way the Canon runs through EDSDK: the SDK's native code can crash or hang without taking printing or sync with it, and `EdsdkSource` supervises the worker (pings, respawn with backoff). The worker speaks the Canon worker's protocol, so nothing above `CameraSource` knows which brand is in a slot.

The Nikon fills one camera position, `capture.nikon.slot` (`"high"` or `"low"`), and the Canon takes the other with whichever driver `capture.canon.driver` says. With a Nikon in the booth, the Camera tab's Swap/Remember don't apply (they pair two Canon bodies by serial) and answer 409; change `slot` in `booth.config.json` instead.

**Only works from the built `dist/`**, like the EDSDK driver.

**Setup:**
1. Install the **Microsoft Visual C++ Redistributable for Visual Studio 2022 (x64)** - the SDK's DLLs need it.
2. Copy everything in the SDK's `Module\Win\BinaryFile\` folder (`ControlServiceLayer.dll`, `NkdPTP.dll`, `NkRoyalmile.dll`, `dnssd.dll` and the three `.config` profiles) into `C:\BoothAgent\nikon\` (or set `capture.nikon.sdkDir`). They're not in git: Nikon's licence doesn't allow redistributing them.
3. The SDK reads the three profiles from `%LOCALAPPDATA%\Nikon\NXTether`. The worker copies them there itself on every start, for the account it runs as - under the service that is LocalSystem's profile (`C:\Windows\System32\config\systemprofile\AppData\Local`), not yours, so there's no manual step.
4. Close NX Tether, Camera Control Pro 2 and Nikon Transfer 2, and remove them from startup. Only one program can hold the camera; while another has it the worker logs "another program has it" and retries.
5. On the camera: set Image quality to **JPEG** (or RAW + JPEG). A RAW-only shot fails with a message saying so. The worker switches the camera to save to the PC (SaveMedia = SDRAM) on every connect, so the photo comes over USB instead of staying on the card.
6. Set `capture.nikon.enabled: true` and `slot`, then `npm ci` (if koffi is new to this checkout - same rules as step 2 of the EDSDK setup) and restart the service.
7. Check `/health/preflight` (`nikon.sdk`, `nikon.profiles`, `nikon.vcRuntime`), then `/health`: the Nikon's slot should show connected with model `Nikon Z 30`.

**How a shot works:** `StartShooting` (single frame, autofocus on) with a private folder next to the capture's destination; the SDK writes the photo there under its own name, and the worker moves the JPEG into place once its size stops changing. If the camera can't focus it retakes without autofocus, the same rule as the Canon's `8D01` handling. Live view starts when the kiosk asks for frames and stops after 10 s without a request; frames are pushed by the SDK, and one older than a second is not served.

**Not done yet:** camera settings from the operator panel (the Nikon's are strings, not EDSDK codes - change them on the camera for now), and a separate pre-focus (the shot itself focuses).

**Native details worth knowing before touching `nikonNative.ts`:** the SDK's structures are `#pragma pack(2)`, so they're read and written as raw bytes at offsets printed from the real headers (`nikonLayout.ts`); the SDK allocates what it hands back with the `malloc` we give it and we free it with the matching `free`; and it calls back from its own threads, so every SDK call goes through koffi's `.async` - a synchronous call would deadlock the first time the SDK waits on a callback. `tests/nikon.native.test.ts` runs the real binding against a mock SDK (built with the system C compiler) that does all three.

## Setup

Requirements on the booth PC:
- **Node.js 22.5+** (for `node:sqlite`)
- **ffmpeg** on `PATH` (or set `capture.webcam.ffmpegPath` to a full path) - used for the webcam fallback
- **digiCamControl** installed and running - used for the Canon path (unless the EDSDK driver is used)
- For the Nikon: its Remote SDK DLLs and the Visual C++ 2022 runtime - see [Nikon control](#nikon-control)
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

`s6x2_2` is the one that matters for `printSize: "2x6-strip"`: the print queue hands HFP the full two-up 4x6 sheet (two identical strips side by side per the acceptance criteria, made from the saved single strip), and dropping that into `s6x2_2` gets the physical cutter to separate it into two individual strips automatically - confirmed on real paper. `s4x6` prints the sheet as-is.

These `s...` names are this rewrite's own internal scheme, not a documented public API, and are exactly the kind of thing to re-verify if you're on a different HFP version - the mapping lives in one place, `hotFolderPathFor()` in `src/print/hotFolder.ts`.

**Setup:**
1. Install DNP Hot Folder Print from the official downloads page. The installer can silently succeed while looking stuck on a repeat launch - if `msiexec` seems hung, check whether it actually already installed via `Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* | Where DisplayName -match HotFolder` before assuming it's frozen.
2. Launch `C:\DNP\HotFolderPrint\HotFolderPrint.exe` once and confirm it sees the printer - check `C:\DNP\HotFolderPrint\Logs\printer_status.txt`, which should show `"Status": "STATUS_OK"` and the right model.
3. Set `printing.hotFolderPath` in `booth.config.json` to `C:\DNP\HotFolderPrint\Prints` - the agent writes into the `s4x6`/`s6x2_2` subfolders itself, it doesn't need them pre-created.
4. Leave `HotFolderPrint.exe` running (start it alongside the tray app, or add it to Windows startup) - like digiCamControl, it needs to be alive to pick anything up.
5. Print one real test job through each size before the event - confirm `s6x2_2` actually comes out as two separated strips, not one uncut sheet.

**Offline behavior - tested, not just assumed.** This version phones home on startup and periodically (`app-shieldv2-prod.azurewebsites.net`, `dnpphoto.com`) and logs occasional `Lost connection.... The system will reconnect automatically.` messages, which looked like a real risk for an agent whose entire premise is working with the venue's internet down. Tested directly: disabled the network adapter, waited 90s, dropped a real composite into `s4x6`, and HFP picked it up, cropped it, and sent it to the printer in about 3 seconds - still fully offline - with a physical print confirmed correct. The Shield/telemetry connection is decorative as far as printing is concerned; it reconnects and resumes its pings once the network comes back, but core hot-folder printing doesn't wait on it.

`GET /health` reports `hotFolder.writable`, checked against the configured `hotFolderPath` root (a denied-permission or full/disconnected drive shows up there immediately).

## Supabase schema setup

The `captures` table and `captures` storage bucket are defined in `supabase/migrations/20260814000000_captures.sql`, not hand-applied - confirmed against the real target project via `information_schema`/`pg_policies` introspection that neither existed yet (the only table in `public` was a leftover `test` table, and `storage.objects` had zero RLS policies). Since each event gets its own fresh Supabase project (see below), this runs once per event, against a brand-new project.

**Manual (how this is actually applied):** paste the file's contents into the target project's SQL Editor (or `supabase db push` if the CLI is linked) before the agent's first run against that project.

**Scripted alternative:** `npm run db:migrate` (`src/scripts/applyMigration.ts`) is also available if you'd rather not use the SQL Editor - it connects directly over Postgres rather than shelling out to the Supabase CLI or `psql`, so nothing beyond `npm install` needs to be on the booth PC:
```powershell
npm run build
npm run db:migrate -- --db-url "postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres"
```
The connection string is under the target project's **Settings → Database → Connection string (URI)** - this is the Postgres superuser connection, a different credential from the `service_role` API key used in `booth.config.json`, and it is not written to any config file. `SUPABASE_DB_URL` works as an environment variable instead of `--db-url` if you'd rather not put the password on the command line. It records each applied filename in a `public._booth_agent_migrations` table, so re-running it against the same project is a no-op - safe to run again, and it only applies migrations added after the last run.

**Access model:** booth-agent runs locally on hardware you control, not in a browser, so it connects with the Supabase **service_role** key (`supabase.serviceRoleKey` in `booth.config.json`), not anon - service_role bypasses RLS by default, so it can insert/update `captures` and read/write the `captures` bucket with no explicit grants needed. `supabase/migrations/20260928000000_public_capture_bucket.sql` makes the `captures` storage bucket public and drops anon's two read policies entirely - anon can no longer list or query anything. A public bucket still only serves an object by its exact path, and the capture id in that path is a random UUID, so a photo is reachable only by someone holding the QR link. The guest-facing download page (`download/`, see `download/README.md`) is part of this repo, is served as static files with no server, and holds no Supabase key at all - it just fetches the public object URL. If a guest page later needs anything beyond reading its own photo (e.g. a "favorite" or share action), that needs a deliberate new policy or a small backend, not a widened bucket.

`toCaptureRecord()` in `src/supabase/supabaseClient.ts` sends exactly the columns the migration creates: `id` (uuid), `event_id` (text), `source` (text, `'canon' | 'webcam'`), `storage_path` (text), `print_size` (text, `'4x6' | '2x6-strip'`, nullable - captures sync before `/composite` runs), `taken_at` (timestamptz).

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

This is a plain PowerShell/.NET `System.Windows.Forms.NotifyIcon` script, not a Node process - it used to be `node dist\tray\trayApp.js` driving the `systray2` npm package, which wraps a prebuilt Go binary (`tray_windows_release.exe`) and talks to it over a stdin/stdout JSON protocol. That binary was confirmed to silently drop menu click events on Windows regardless of how the menu items were managed on the Node side, and since it ships prebuilt with no source available in the npm package, it couldn't be patched. `install\start-tray.ps1` now handles both status and menu clicks itself: "Open Data Folder" and "Quit tray" go through the normal WinForms message loop instead of a third-party stdio bridge, which is what actually makes them reliable.

## Installing as a Windows service

From an elevated PowerShell prompt:
```powershell
npm install
npm run build
.\install\install-service.ps1
```
This registers a service (via `node-windows`, which wraps `sc.exe`) that runs `node dist\index.js`, starts on boot, and restarts on crash. `BoothAgent` is only the service's **DisplayName** - the actual service **Name** is `boothagent.exe`, and that's what `Get-Service`/`Restart-Service`/`Stop-Service` should be given: `Restart-Service boothagent.exe`, not `Restart-Service BoothAgent`. Alternatively, use `services.msc` and look for it listed as "BoothAgent".

To remove it:
```powershell
.\install\uninstall-service.ps1
```

## Configuration reference

See `booth.config.example.json` for the full shape (validated by `src/config/schema.ts` on load and on every edit). Highlights:

| Key | Meaning |
|---|---|
| `agent.sharedSecret` | Required on every request as `Authorization: Bearer <secret>` (or `?token=` for `<img>`/WS clients that can't set headers). Loopback binding is the real security boundary; this just stops other local processes from poking the agent by accident. |
| `agent.allowedOrigins` | Origins allowed to make cross-origin requests to the agent - the kiosk UI's own origin, when it isn't served from `127.0.0.1` itself (e.g. a dev server on another port, or a kiosk browser pointed at a hostname). Empty (`[]`) by default: CORS is opt-in per deployment. Without the kiosk's origin listed here, its `Authorization`-bearing requests never get past the browser's own CORS preflight - the agent itself stays healthy and answering, but DevTools reports a CORS error and `fetch()` calls fail, while `<img src="/liveview?token=">` keeps working since images aren't subject to CORS. See `src/server/cors.ts`. |
| `capture.sourcePreference` | `"canon"` or `"webcam"` - which one the manager prefers when both are healthy. |
| `capture.canon.driver` | `"digicamcontrol"` (default) or `"edsdk"`: how the Canon is controlled. Read at startup; restart the service after changing it. |
| `capture.canon.edsdkDllPath` | Where the 64-bit `EDSDK.dll` lives. Default `C:\BoothAgent\edsdk\EDSDK.dll`. |
| `printing.hotFolderPath` | HFP's `Prints` folder (typically `C:\DNP\HotFolderPrint\Prints`); the agent writes into its `s4x6`/`s6x2_2` subfolders (see above). |
| `printing.hotFolderStallSeconds` | How long a dropped file may sit in the hot folder before `/health` reports `hot-folder-stalled`. Default 120s. HFP claims a file by moving it, normally within a second or two, and doesn't wait for the print to finish - so this doesn't need to cover print time. |
| `compositing.templateDir` | Where `<templateId>.json` template files and the images their layouts use live. 4x6 cells are 1200x1800 (portrait) or 1800x1200 (landscape, turned onto the sheet at print time); 2x6-strip cells are 600x1800. Each photo element takes one shot (its `shot` number); the highest shot + 1 is how many photos a guest takes. Old `photoSlots` templates still load and are converted. Copy `assets/templates/*.json` here on setup: `default-4r-grid` (landscape, 4 photos), `default-4r-three` (landscape, 1 big + 2 small), `default` (portrait, 1 photo), `default-strip` (2x6 strips, 3 photos). The kiosk's layout editor adds more. |
| `event.id` | Seed only: the first event in `<dataDir>/events.json`, used on the first start. After that events are switched and created from the kiosk's Events tab, and this is ignored. |
| `event.name` | Optional seed for that first event's display name, printed wherever a layout's text says `{event}`. Falls back to `event.id`. |

`booth.config.json` is watched for changes and re-validated on save; `capture.sourcePreference`, `agent.sharedSecret`, and `agent.allowedOrigins` all take effect immediately without a restart, since each request reads them fresh off `ConfigStore.current` rather than a value captured at startup. Other fields (ports, paths) require a restart since they're read once at startup by things like the HTTP listener and DB connection.

## API

All endpoints require `Authorization: Bearer <sharedSecret>` (or `?token=`).

- `GET /health` - camera (active source, model, both sources' connection state), hot folder writability, disk free/total, outbox queue depth/last sync/last error, and the active event (`eventId`, `eventName`, `eventDate`). An unreadable `events.json` raises the `events-file-unreadable` error alert; the agent then runs on booth.config.json's event and can't switch until the file is fixed and the service restarted.
- `GET /liveview` - MJPEG multipart stream (`multipart/x-mixed-replace`), Canon live view when active, webcam otherwise.
- `POST /camera/prefocus` - `202`; asks the camera to autofocus now for an imminent capture. A no-op unless the EDSDK driver is active.
- `GET /camera/settings` - the Canon's operator-adjustable settings (ISO, aperture, shutter, white balance, exposure comp, quality) as `{ mode, settings, rejected }` plus `saved`, what's in `camera.json`. EDSDK driver only; `409` otherwise (and if the camera isn't connected).
- `POST /camera/settings` - body is a partial of raw EDSDK codes `{ iso?, av?, tv?, wb?, ev?, quality? }` (`400` on anything else). Applies them now and returns the same shape as the `GET`; only the keys the camera actually accepted (i.e. not in the response's `rejected`) are written to `camera.json`, so a reconnect doesn't keep retrying a value the camera refuses.
- `POST /camera/settings/reset` - clears `camera.json`. Returns `{ saved: {} }`.
- `POST /camera/test-shot` - captures one JPEG on the active source (Canon or webcam) and streams it back as `image/jpeg` with an `X-Capture-Source` header, so the operator can judge exposure/white balance before an event. Unlike `/capture`, it makes no capture row, isn't printed or synced, and the file is deleted once sent.
- `POST /capture` - triggers a capture on the active source. Returns `{ captureId, filePath, width, height, source, takenAt }`.
- `GET /captures/:id/image` - the original JPEG for a capture, so the kiosk can show it on the review screen (`/capture` only returns a local path a browser cannot open). Add `?variant=composite` for the composite instead: the photo the guest holds, upright (a landscape 4x6 stays 1800x1200, a strip is one 600x1800 strip). Only the file dropped into the hot folder is turned onto the portrait 4x6 sheet (landscape turned a quarter clockwise, strips two-up), written once next to the composite as `<name>-sheet.jpg`; composites saved before this change are already sheets and print as they are. Use `?token=` from an `<img src>`. `404` if the id is unknown, it has not been composited yet (for `variant=composite`), or the file is gone.
- `POST /composite` - body `{ captureId, templateId, captureIds?, printSize?, aiOutputUrl? }`. `captureIds` lists every shot of a multi-photo session in slot order, starting with `captureId`; slot *i* gets shot *i* (fewer shots than slots repeat from the start). The composite is filed under `captureId`, so `/print` and reprints take that id. `printSize` defaults to the template's own size. Applies the named template; if `aiOutputUrl` is given, downloads that image first and composites from it instead of the original capture (this is the "AI output pulled back down from Supabase" path). `aiOutputUrl` must be on the same origin as `supabase.url` - `assertAllowedAiOutputOrigin()` in `src/server/routes.ts` rejects anything else, since a client-supplied URL fetched with no restriction would otherwise let anyone with the shared secret point the agent's `fetch()` at internal/loopback addresses it has no reason to reach. `templateId` is similarly restricted to `[A-Za-z0-9_-]+` (see `SAFE_TEMPLATE_ID` in `src/compositor/template.ts`) so it can't be used to read files outside `compositing.templateDir` via `../` traversal. Returns the composite's file path.
- `POST /print` - body `{ captureId, size?, copies? }` (`copies` defaults to 1, max 5). Requires the capture to have been composited first. Each copy is queued as its own print job, in order. Returns `{ jobId, queuePosition, estimatedWaitMs }` immediately for `copies: 1`; for `copies > 1` returns `{ captureId, jobs: [...] }` instead, one entry per copy (same shape `/print/reprint` uses).
- `GET /print/queue` - pending jobs with live-recomputed queue position and estimated wait (`secondsPerPrint` × position).
- `GET /print/history` - recent print jobs, newest first (`?limit=`, default 20, max 200). After a media change this is how you find jobs that were dropped into the hot folder while the printer had no paper.
- `POST /print/reprint` - body `{ jobId | captureId, size?, copies? }` (exactly one of `jobId`/`captureId`). Re-queues an existing composite; `409` if that file is no longer on disk.
- `GET /health/preflight` - the stored preflight result. `POST /health/preflight` re-runs it and replaces the stored one; run this once the booth is actually set up, since the boot-time run is necessarily pessimistic about anything that starts after this service does.
- `GET /sync/abandoned` - captures the sync worker gave up on, with the file it expected and why it failed.
- `POST /sync/abandoned/retry` - put all of them back in the queue. Returns `{ requeued }`.
- `GET /templates` - every layout in `compositing.templateDir`. A layout is a background colour plus `elements` in layer order (bottom first): `photo` (`shot`), `image` (`file`), `text` (`text`, `font`, `size`, `color`, `align`, `bold`; `{event}` `{date}` `{time}` `{code}` are filled in per print) and `rect` (`fill`, `radius`, `opacity`), each with `x`, `y`, `width`, `height`, `rotation` and `hidden`. `POST /templates/:id` saves one (old or new format; validated for cell size, shots, fonts and images). `POST /templates/:id/delete` removes one and its images (`409` if it's the layout in use). `POST /templates/:id/assets` uploads an image (`Content-Type: image/png` or `image/jpeg`, max 10 MB) and returns `{ file }`; `GET /templates/:id/assets/:file` serves it. `GET /fonts` lists the bundled fonts and `GET /fonts/:file` serves one. Everything is POST so the CORS allowlist stays GET/POST.
- `POST /layout-preview` renders a draft layout (the template JSON; saved or not) with numbered sample photos and returns it upright as `image/jpeg`, the way the guest holds the print. `POST /layout-preview/print` sends the printed sheet (turned or two-up as above) straight to the hot folder as one test print (`202 { jobId }`); it makes no capture or print-job row, so nothing syncs to Supabase. Drafts follow the same image rule as a save.
- `GET /templates/:id/export` returns one JSON file with the layout and its images (`{ format: "kachak-layout", version: 1, template, assets: { file: base64 } }`). `POST /layout-import` takes that file (up to 60 MB, read only after auth) and saves it as a new layout, never overwriting one. `POST /templates/:id/copy` with `{ name, template }` saves a draft of that layout as a new layout with its images copied ("Save as new"). New ids come from the name.
- `GET /session` / `POST /session` - `{ templateId, firstCountdownSeconds, betweenShotsSeconds }` (seconds 1-10), set from the kiosk's operator panel. Stored on the active event in `<dataDir>\events.json` (each event keeps its own settings), not in `booth.config.json`; a leftover `session.json` only seeds the first event. `GET` also returns the resolved `template`; its number of photo slots is how many shots the kiosk takes. Defaults: `default-4r-grid`, 3 s, 3 s. The file also holds `attractSlideshow` (default `true`); a `POST /session` without it keeps the current value.
- `GET /album-info` - `{ token, eventId, eventName, attractSlideshow }` for the kiosk's operator Album tab (`token` is the active event's album token, or null for an event with no album, e.g. one migrated without a token). Never in `/health`.
- `POST /attract-slideshow` - `{ enabled: boolean }`: whether the kiosk's Attract screen shows this event's prints.
- `GET /events` - `{ activeId: string, events: Array<{ id, name, date, photoCount }> }` newest date first. For the operator panel's Events tab to list and switch between events. Active event lives in `<dataDir>/events.json`, seeded from `event` and `album.token` in `booth.config.json` on first start; those two config keys are ignored thereafter. New events get their own album token automatically. To hand-edit `events.json`, stop the service first: the running agent never re-reads the file and overwrites it on its next write. To revoke a leaked album link, edit that event's `albumToken` in `events.json` with the service stopped.
- `POST /events` - body `{ name: string, date?: string }` (name trimmed, 1–80 chars; date is YYYY-MM-DD or today if omitted). Creates a new event and makes it active. Returns `201 { id, name, date }`, `400 { error }` on validation failure, or `500 { error }` if `events.json` is unreadable.
- `POST /events/:id/activate` - switches the active event (where the next capture goes) and refreshes its album. Returns `200 { id, name, date }`, `404 { error }` for an unknown event, or `500 { error }` if `events.json` is unreadable.
- `POST /events/:id/delete` - takes an event off the list. It is only marked `deleted` in `events.json`: its photos, Supabase folder and album link stay, late uploads still update its album, and its id is never reused. Returns `200 { deleted }`, `404 { error }` for an unknown (or already deleted) event, `409 { error }` for the event in use (switch first), or `500 { error }` if `events.json` can't be written.
- `WS /events` - `capture-taken`, `sync-status`, `print-queued`, `print-completed`, `camera-disconnected`, `camera-fallback`, `camera-recovered`, `error`. For a Canon, `camera-disconnected`/`camera-recovered` carry `camera: "high" | "low"`; the low camera (EDSDK only) sends them whenever it drops or comes back. Connect with `ws://127.0.0.1:7070/events?token=<sharedSecret>`.

## Testing the acceptance criteria

Run `npm test` first for the automated coverage (outbox sync worker offline→online behavior, 2x6 strip compositor output, camera fallback/recovery timing, hot-folder write atomicity and print-job crash recovery, webcam capture/live-view device serialization, templateId/aiOutputUrl input validation, timing-safe shared-secret comparison) - `npm run build` then `npm test` (or `npm run test:watch`). The rest below are manual, on the real hardware.

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

**Prints are physically coming out, not just being dropped**

The one failure where every other signal stays green: the copy into the hot folder succeeds, HFP keeps its status file warm so the printer reports `STATUS_OK`, `print-completed` fires off a timer so the kiosk tells the guest their photo is ready - and nothing comes out. Seen in practice when HFP re-initialised and began watching a `<size>\<printer>-<n>\` subfolder instead of the folder the agent drops into, and separately when the HFP window was closed while its background pieces kept writing status.

1. `POST /print`, then watch the file appear in `Prints\s4x6\` and disappear within a second or two. HFP claims a file by moving it, so disappearance is the only honest evidence it was picked up.
2. If it's still there after `printing.hotFolderStallSeconds`, `/health` reports `hot-folder-stalled` at error level with the count, how long the oldest has waited, and the paths.
3. To reproduce deliberately: close the HFP window, drop a print, and confirm `/health` goes red within the threshold while `printer.ok` stays `true`.
4. `mediaRemaining` is the independent cross-check - it only moves when paper physically feeds.

**Composite actually reaches Supabase (the online ordering)**

1. With the network **up**, `POST /capture` and wait ~5s - long enough for the sync worker to push the original.
2. `POST /composite` for that capture.
3. Within a couple of ticks, `/health` `outbox.queueDepth` should go to 1 and back to 0.
4. In Supabase Storage, the object for that capture id must be the **templated** image, and its `captures` row must have `print_size` set. Before this was fixed it stayed the raw original with a null `print_size`.
5. `npm test` covers this ordering both ways round in `tests/outbox.composite.sync.test.ts`.

**Abandoned captures**

1. Take a capture offline so it queues, then delete its file from `data\originals`.
2. Reconnect. That row should move to abandoned rather than retrying forever: `/health` shows an `outbox-abandoned` warn, `queueDepth` excludes it, and `GET /sync/abandoned` lists it.
3. `POST /sync/abandoned/retry` should put it back in the queue (and, with the file still missing, abandon it again on the next attempt).

**`/health` accuracy**
- Full disk: fill the data volume (or point `storage.dataDir` at a near-full drive) and confirm `disk.freeBytes` reflects it.
- Unwritable hot folder: point `printing.hotFolderPath` at a read-only location (or revoke write ACLs) and confirm `hotFolder.writable: false`.
- Disconnected camera: unplug both the Canon and any webcam; confirm `camera.activeSource: "none"` and `POST /capture` returns `503`.

**Crash/restart resumption**
1. Take several captures while offline so they queue up.
2. Kill the agent process (or `Stop-Service boothagent.exe`) mid-sync.
3. Restart it. `SyncWorker` resets anything stuck in `'uploading'` back to `'pending'` on startup (`OutboxStore.resetStuckUploads()`) and resumes - confirm nothing duplicates in Supabase and nothing gets lost (`outbox.queueDepth` eventually reaches 0).
4. Separately, queue a print (`POST /print`) and kill the agent before the drop into the hot folder can be confirmed. On restart, `OutboxStore.resolveInterruptedPrintJobs()` marks any job still `'queued'` as `'failed'` rather than silently reprinting it - whether the file actually landed before the crash can't be determined after the fact, so the operator has to make that call, not the agent. A clean shutdown (`Stop-Service` completing normally) instead drains in-flight print jobs via `PrintQueue.stop()`, so a planned restart should find nothing left for recovery to resolve.

**Loopback-only binding**
```powershell
netstat -ano | findstr :7070
```
Every line must show `127.0.0.1:7070`, never `0.0.0.0:7070`.

## Known limitations

- **Upgrading an existing booth PC re-uploads some history once.** The schema block is `CREATE TABLE IF NOT EXISTS`, so `synced_source_path` and `sync_abandoned_at` arrive on an existing `data\outbox.db` via `ALTER TABLE` (`ensureColumn()` in `src/outbox/db.ts` - additive and idempotent, no table rebuild, so the `print_jobs` foreign key is never disturbed). Nothing on disk records which file a pre-upgrade row actually uploaded, so only rows that were never composited can be marked finished; every already-synced row that *has* a composite is re-uploaded once on the first sync pass after the upgrade. That is the intended repair for captures stranded by the bug above, and it is harmless for the rest - same storage key, same bytes. Expect a one-time burst proportional to past events, so do the upgrade on a connection you don't mind using, not at a venue.

- **Webcam live view** used to spawn a fresh `ffmpeg` process per preview frame, capping smoothness at a few fps. `WebcamSource` now starts one long-lived `ffmpeg` process per live-view session, streaming continuous MJPEG over its stdout; `MjpegFrameParser` (`src/camera/mjpegFrameParser.ts`) demuxes that raw byte stream by scanning for JPEG SOI/EOI marker pairs (`0xFFD8`...`0xFFD9`), and `getLiveviewFrame()` just hands back whichever frame decoded most recently. The process is stopped and its device handle released after `LIVEVIEW_IDLE_TIMEOUT_MS` (2s) of nobody polling it - well over the ~150ms `/liveview` poll interval, so an actively-watched stream never drops, but a guest closing the kiosk view or `CameraManager` switching away to Canon lets it go quickly rather than holding the webcam open unattended for the rest of the event. `capture()` and `getLiveviewFrame()` are still serialized through an internal `AsyncMutex` (see `src/util/mutex.ts`) since both need exclusive use of the same dshow device - a guest pressing the shutter now stops the live-view stream first, takes the still, and lets the next live-view poll restart the stream, rather than racing it for the device and risking "device busy".
- **`CanonTetheredSource.capture()` is similarly serialized**, for a different reason: it's three sequential `CameraControlRemoteCmd.exe` calls against one shared digiCamControl session (set folder, set filename, then `Capture`), not atomic as a group. Two overlapping `/capture` requests could otherwise interleave their command sequences - one guest's shutter firing under the other's `filenametemplate` - so it shares the same `AsyncMutex` pattern (its own instance, scoped to capture only; Canon live view goes over a separate HTTP surface with no such exclusivity to race).
- **digiCamControl and Hot Folder Print's exact commands/folder names are version-pinned, not documented public APIs.** Both were verified live (digiCamControl 2.1.7.0, Hot Folder Print 3.6.37) against real hardware, and both already turned out to differ from what generic vendor docs describe. Re-verify against your installed versions if either changes - see the callouts in the Canon and DNP sections above for exactly how.
- **Supabase `captures` schema** - previously a best guess written without access to the real project; now defined in `supabase/migrations/20260814000000_captures.sql` and verified against the actual target project (which had no `captures` table or bucket at all - see [Supabase schema setup](#supabase-schema-setup)). It's pasted into the SQL Editor by whoever provisions each event's project, before the agent's first real run against it; nothing in this repo triggers that automatically on agent startup, and `npm run db:migrate` exists as a scripted alternative but isn't the applied workflow. The upload/upsert mechanics themselves (idempotent retry, no duplicate rows/objects) were separately verified end to end against a real local Supabase stack (Postgres + Storage via `supabase start`/Docker).
  - **Offline endurance** was separately verified against real hardware: took 20 real captures on a tethered R100 with the Supabase backend fully unreachable (stopped, not just misconfigured). Every capture succeeded immediately and was never blocked or delayed by the failing sync - confirmed the outbox and camera/print paths are fully decoupled from connectivity, as designed. All 20 queued locally with `sync_status = 'failed'` and infinite retry eligibility (no attempt cap - see `outboxStore.ts`'s query, which matches on `('pending', 'failed')` with no attempt-count filter). On reconnect, all 20 synced automatically with no code changes or restart needed; verified via three independent sources agreeing exactly - the local SQLite outbox, a fresh Postgres row count, and a fresh Storage object count all showed 21/21 (20 offline + 1 online sanity check), with the local and remote ID sets an exact match (`diff` on sorted ID lists was empty). No bugs found in this pass.
- **`copies` on `POST /print` and `/print/reprint` (capped at 5) queues that many fully separate, serialized print jobs**, not one job with a repeat count - Hot Folder Print has no notion of "print this file N times", so the agent drops N distinct files and each gets its own `secondsPerPrint` slot in the queue's wait-time estimate; five copies take roughly 5× as long as one, not a bulk-print shortcut. `POST /print` also changes response shape once `copies > 1`: a single job object (`{ jobId, queuePosition, estimatedWaitMs }`) for the default `copies: 1`, or `{ captureId, jobs: [...] }` otherwise - see the [API](#api) section.
