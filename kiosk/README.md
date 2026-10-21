# Kachak kiosk

Guest-facing touchscreen UI for the photobooth. It talks to [booth-agent](https://github.com/Daniel-gigsmore/booth-agent) on the same PC. The screens follow the "Kachak Booth Kiosk" design canvas.

Flow: Attract → Get ready (live view; one countdown and shot per photo slot in the layout) → Review (shows the actual print; prints automatically after 10 s) → Printing → Done (QR download). If the Canon reports busy mid-burst, the kiosk retries that shot twice, 1 s apart. If a capture or print fails, the guest sees the "Let's try that again" screen. Any screen except Attract goes back to Attract after 60 s with no touch.

**Attract prints:** Attract shows this event's prints, fading from one to the next (6 s each, new prints first), where the sample strips normally sit. They come from booth-agent, so this works offline. It falls back to the sample strips while there are no prints, or when the operator turns the album off for guests in the Album tab.

**Album in the kiosk:** with prints, a **View album** button sits under them on Attract. It opens every print so far as a grid, newest first and printed prints only (swipe or use the scroll wheel). Tap one to see it large with ‹ › and its **download QR code**, the same page as the Done screen's. **▶ Play** runs a slideshow, and a tap stops it. ✕ goes back, as does 60 s with no touch.

**Mouse:** guests use the touchscreen, so the pointer is hidden. It appears while a mouse moves and hides again after 3 s. The scroll wheel scrolls lists.

**Operator panel:** tap the lock in the top-right corner of Attract. Its ring is green, amber or red to match booth-agent's `/health` `overall`. The panel has five tabs:

- **Status:** camera, printer, sync and hot folder health, plus the last 3 prints with Reprint.
- **Settings:** pick the layout in use, set the countdown for the first photo and between photos (1–10 s), and create, edit or delete layouts. Changes apply to the next guest.
- **Camera:** each Canon's settings, live view and a test shot.
- **Album:** the online album link and its QR code, to send to the client (needs the active event to have an album token - new events get one automatically - and `VITE_DOWNLOAD_URL` here). **Slideshow on second screen** opens the booth's own album full screen on the TV or projector. Chrome must allow "window management" for the kiosk; if it doesn't, run `start-slideshow.ps1`. **Open album** opens the kiosk's album (always, even when it's hidden from guests; ✕ comes back here). **Hide album from guests** turns off both the Attract prints and the View album button.
- **Events:** lists the events with their printed-photo counts and marks the one in use. **Switch** changes the booth to another event, and **Create and switch** starts a new one; photos, layout settings and the album link follow it, and the kiosk reloads on the new event. **Delete** (tap twice) takes an event other than the one in use off the list; its photos and album link stay.

**Layout editor:** the left column adds a photo (each photo number is one shot), an image (PNG or JPEG, uploaded to booth-agent), a text or a shape, and sets the background colour and paper. Drag an element to move it and its orange corner dot to resize it. The Selected panel has exact X/Y/W/H, rotation, keep-aspect-ratio, align-to-paper and "Fill paper" controls, plus text (font, size, colour, bold, alignment, and the `{event}` `{date}` `{time}` `{code}` variables filled in per print), shape and photo-number settings. The Layers panel lists elements top first, with show/hide, up/down and delete. Undo/Redo keep the last 50 steps. The editor draws text with booth-agent's own font files, so it looks like the print; line breaks may differ slightly.

**Preview and test print:** Preview renders the layout on booth-agent with numbered sample photos, so it is exactly what prints. From the preview, Test print sends one sheet to the printer (tap twice; it uses paper, and nothing is uploaded). **Save as new** stores the current draft as a separate layout ("<name> copy" unless you renamed it). In Settings, **Export** saves a layout and its images to one `.kachak-layout.json` file in Downloads, and **Import** loads such a file as a new layout.

## Setup

1. Copy `.env.example` to `.env`. Set `VITE_AGENT_TOKEN` to booth-agent's `agent.sharedSecret`. The event name and date on the strip and screens come from booth-agent's active event (Operator → Events), so there is nothing to set here and switching events needs no rebuild. To show the guest download QR, set `VITE_DOWNLOAD_URL` to the page link with placeholders, e.g. `https://<site>/?event={eventId}&name={eventName}&id={captureId}` (`{eventId}` and `{eventName}` are filled from the active event, `{captureId}` per photo).
2. Add the kiosk's origin (for example `http://127.0.0.1:4173`) to `agent.allowedOrigins` in booth-agent's `booth.config.json`.
3. Build and serve the kiosk:

```bash
npm install
npm run build
npm run preview
```

4. Open the page in Chrome in kiosk mode: `chrome --kiosk http://127.0.0.1:4173`.

To start it with Windows, put a shortcut to `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <path>\start-kiosk.ps1` in `shell:startup`. At login, the script starts the server if it isn't already running, then opens Chrome in kiosk mode using its own profile. Exit with Alt+F4. After changing `.env` or the code, run `npm run build` again.

Requires booth-agent with element-based layouts (booth-agent PR #42). The agent puts the bundled layouts into `compositing.templateDir` itself when that folder is missing or empty.

The fonts are bundled, so the kiosk works offline. The shared secret is baked into the built JS. That is fine because the kiosk is only served on the booth PC; do not host `dist/` anywhere public.

## Deploying to the booth PC

The source lives in the booth-agent repo; the booth PC serves the build from `C:\BoothAgent\kiosk`, which keeps its own `.env.local` (with the shared secret) and `node_modules`. Deploy the agent first if the kiosk needs a newer agent. Then, from PowerShell in the repo root:

```powershell
robocopy kiosk\src C:\BoothAgent\kiosk\src /MIR
Copy-Item kiosk\index.html, kiosk\package.json, kiosk\package-lock.json, kiosk\tsconfig.json, kiosk\vite.config.js, kiosk\start-kiosk.ps1, kiosk\start-slideshow.ps1, kiosk\README.md, kiosk\.env.example C:\BoothAgent\kiosk\
cd C:\BoothAgent\kiosk
npm install
npm run build
```

`/MIR` is only used on `src\`, which holds no secrets. Never mirror the whole folder: it would delete `.env.local`. `vite preview` serves the new `dist\` straight away; reload the kiosk page (Ctrl+R, or Alt+F4 and reopen the "Kachak Kiosk" shortcut). A changed `vite.config.js` only takes effect once the preview server restarts: stop the hidden `node ... vite.js preview` process, then reopen the "Kachak Kiosk" shortcut.

**Minimize kiosk** (operator panel) minimizes the full-screen kiosk so you can use the desktop. Tap Chrome in the taskbar to bring it back.

## One installer for the booth (recommended)

`install\build-installer.ps1` (repo root, on Windows with Node and Inno Setup 6) builds `installer\Kachak Booth Setup <version>.exe`. It installs everything the booth PC needs in one go: booth-agent as the BoothAgent Windows service in `C:\BoothAgent\agent`, and this kiosk as an app in `C:\BoothAgent\agent\kiosk`, with "Kachak Kiosk" shortcuts on the desktop and in All Users startup.

On a new booth the installer writes `booth.config.json` with a fresh random `agent.sharedSecret` and opens it in Notepad: fill in the rest (Supabase, printer, camera, and `kiosk.downloadUrl` for the guest QR), save and close. Nothing needs copying between the two programs: the kiosk reads `agent.port`, `agent.sharedSecret` and `kiosk.downloadUrl` from the agent's `booth.config.json` each time it loads, so the installer carries no secret and a changed port, secret or link only needs a reload (Ctrl+R) and, for the port or secret, a restart of the BoothAgent service. `agent.allowedOrigins` must include `http://127.0.0.1:4173`; new configs have it, and the installer warns if an existing one doesn't.

Upgrading: run the newer `Kachak Booth Setup` over the old one. `booth.config.json` is kept. The installer stops the kiosk and the service, removes the standalone "Kachak Kiosk" app if it's installed, and deletes the old `start-kiosk.ps1` startup shortcut. If the Chrome kiosk's `vite preview` is still running, end it (or restart the PC) so port 4173 is free.

In the app, **Slideshow on second screen** opens the album full screen on the other screen directly, and **Export** saves into Downloads. Opening the shortcut while the kiosk runs brings the running one to the front.

## Installer (Electron)

Instead of the steps above, the kiosk can be installed as a desktop app. With `.env.local` filled in, run `npm run electron:pack` in `kiosk\`. It writes `installer\Kachak Kiosk Setup <version>.exe`. The app serves the build on `http://127.0.0.1:4173` itself (the origin booth-agent already allows), opens it full screen, and starts at login. Before installing, stop the old setup: delete the "Kachak Kiosk" shortcut from `shell:startup` and end the `vite preview` process, otherwise port 4173 is busy and the app says so. The installer contains the shared secret, so don't share it. It is unsigned, so SmartScreen warns on install. `npm run electron:dev` runs the app without installing. Set `KACHAK_KIOSK_PORT` to try it on another port while the old kiosk runs (agent calls then fail CORS).
