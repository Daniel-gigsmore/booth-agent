# Kachak kiosk

Guest-facing touchscreen UI for the photobooth. It talks to [booth-agent](https://github.com/Daniel-gigsmore/booth-agent) on the same PC. The screens follow the "Kachak Booth Kiosk" design canvas.

Flow: Attract → Get ready (live view; one countdown and shot per photo slot in the layout) → Review (shows the actual print; prints automatically after 10 s) → Printing → Done (QR download). If the Canon reports busy mid-burst, the kiosk retries that shot twice, 1 s apart. If a capture or print fails, the guest sees the "Let's try that again" screen. Any screen except Attract goes back to Attract after 60 s with no touch.

**Operator panel:** tap the small status dot in the top-right corner of Attract 5 times quickly (each tap within 1 second of the last). The dot is green, amber or red to match booth-agent's `/health` `overall`. The panel has two tabs:

- **Status:** camera, printer, sync and hot folder health, plus the last 3 prints with Reprint.
- **Settings:** pick the layout in use, set the countdown for the first photo and between photos (1–10 s), and create, edit or delete layouts. Changes apply to the next guest.

**Layout editor:** drag a photo box to move it, and drag the orange corner dot to resize it (it keeps the camera's 3:2 shape unless you untick that). Choose the paper (4R landscape, 4R portrait, 2×6 strips) and add or remove photos; each photo box is one shot. You can upload a PNG overlay (a frame, logo or event name, with transparent holes where the photos go) and save. Layouts are stored by booth-agent in `compositing.templateDir`.

## Setup

1. Copy `.env.example` to `.env`. Set `VITE_AGENT_TOKEN` to booth-agent's `agent.sharedSecret`.
2. Add the kiosk's origin (for example `http://127.0.0.1:4173`) to `agent.allowedOrigins` in booth-agent's `booth.config.json`.
3. Build and serve the kiosk:

```bash
npm install
npm run build
npm run preview
```

4. Open the page in Chrome in kiosk mode: `chrome --kiosk http://127.0.0.1:4173`.

To start it with Windows, put a shortcut to `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <path>\start-kiosk.ps1` in `shell:startup`. At login, the script starts the server if it isn't already running, then opens Chrome in kiosk mode using its own profile. Exit with Alt+F4. After changing `.env` or the code, run `npm run build` again.

Requires booth-agent with the multi-photo layout and `/session` endpoints (booth-agent PR #40), plus the bundled layouts copied into `compositing.templateDir`.

The fonts are bundled, so the kiosk works offline. The shared secret is baked into the built JS. That is fine because the kiosk is only served on the booth PC; do not host `dist/` anywhere public.

## Deploying to the booth PC

The source lives in the booth-agent repo; the booth PC serves the build from `C:\BoothAgent\kiosk`, which keeps its own `.env.local` (with the shared secret) and `node_modules`. Deploy the agent first if the kiosk needs a newer agent. Then, from PowerShell in the repo root:

```powershell
robocopy kiosk\src C:\BoothAgent\kiosk\src /MIR
Copy-Item kiosk\index.html, kiosk\package.json, kiosk\package-lock.json, kiosk\tsconfig.json, kiosk\start-kiosk.ps1, kiosk\README.md, kiosk\.env.example C:\BoothAgent\kiosk\
cd C:\BoothAgent\kiosk
npm install
npm run build
```

`/MIR` is only used on `src\`, which holds no secrets. Never mirror the whole folder: it would delete `.env.local`. `vite preview` serves the new `dist\` straight away; reload the kiosk page (Ctrl+R, or Alt+F4 and reopen the "Kachak Kiosk" shortcut).
