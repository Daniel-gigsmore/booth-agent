const { app, BrowserWindow, ipcMain, dialog, screen } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

// Same origin the Chrome kiosk used, so booth-agent's agent.allowedOrigins needs no change.
const PORT = Number(process.env.KACHAK_KIOSK_PORT) || 4173;
const KIOSK_URL = `http://127.0.0.1:${PORT}`;
const DIST = path.join(__dirname, "..", "dist");
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

/**
 * In the combined "Kachak Booth" installer the app sits in <agent>\kiosk, so booth-agent's own
 * booth.config.json is one folder up. Reading the port, the shared secret and the download link
 * from it at runtime means the installer carries no secret, and a changed secret, port or link
 * needs no rebuild. Outside that layout (the standalone kiosk installer, electron:dev) there is no
 * such file and the values baked in from .env.local are used, as before.
 */
const BOOTH_CONFIG =
  process.env.KACHAK_BOOTH_CONFIG ||
  (app.isPackaged ? path.join(path.dirname(process.execPath), "..", "booth.config.json") : "");
const bundled = BOOTH_CONFIG !== "" && fs.existsSync(BOOTH_CONFIG);

function runtimeConfig() {
  if (!BOOTH_CONFIG || !fs.existsSync(BOOTH_CONFIG)) return null;
  try {
    // Notepad may save it with a BOM.
    const cfg = JSON.parse(fs.readFileSync(BOOTH_CONFIG, "utf8").replace(/^﻿/, ""));
    return {
      agentUrl: `http://127.0.0.1:${cfg.agent?.port ?? 7070}`,
      token: cfg.agent?.sharedSecret ?? "",
      downloadUrl: cfg.kiosk?.downloadUrl ?? "",
    };
  } catch (e) {
    dialog.showErrorBox("Kachak Kiosk", `Could not read ${BOOTH_CONFIG}:\n\n${e.message}`);
    return null;
  }
}

function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, KIOSK_URL).pathname);
      const file = path.join(DIST, rel === "/" ? "index.html" : rel);
      if (!file.startsWith(DIST + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(data);
      });
    });
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
}

let win;
let slideshow;

/** The album slideshow, full screen on the first screen that isn't the kiosk's. Returns an error for the operator, or null. */
function openSlideshow(url) {
  const here = screen.getDisplayMatching(win.getBounds());
  const other = screen.getAllDisplays().find((d) => d.id !== here.id);
  if (!other) return "Only one screen is connected. Plug in the TV or projector first.";
  if (slideshow && !slideshow.isDestroyed()) slideshow.close();
  slideshow = new BrowserWindow({ ...other.bounds, fullscreen: true, autoHideMenuBar: true, backgroundColor: "#000" });
  slideshow.loadURL(url);
  return null;
}

async function start() {
  try {
    await serve();
  } catch (e) {
    dialog.showErrorBox(
      "Kachak Kiosk",
      `Port ${PORT} is busy. Close the old kiosk (the standalone Kachak Kiosk app, or start-kiosk.ps1's vite preview) and open this again.\n\n${e.message}`,
    );
    app.quit();
    return;
  }
  win = new BrowserWindow({
    kiosk: true,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  // Nothing in the kiosk should open a stray browser window; the slideshow goes through openSlideshow.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // "Export" in the operator panel: straight into Downloads, as in Chrome, instead of a save dialog behind the kiosk.
  win.webContents.session.on("will-download", (_e, item) => {
    item.setSavePath(path.join(app.getPath("downloads"), item.getFilename()));
  });
  win.loadURL(KIOSK_URL);
}

// Read per page load, so a reload (Ctrl+R) after editing booth.config.json picks it up.
ipcMain.on("config", (e) => {
  e.returnValue = runtimeConfig();
});
ipcMain.handle("open-slideshow", (_e, url) => openSlideshow(String(url)));
ipcMain.on("minimize", () => win?.minimize());
ipcMain.on("close", () => win?.close());

// One kiosk only: opening the shortcut again brings the running one back instead of failing on the port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  // The combined installer adds its own All Users startup shortcut (and removes it on uninstall).
  if (app.isPackaged && !bundled) app.setLoginItemSettings({ openAtLogin: true });
  app.whenReady().then(start);
  app.on("window-all-closed", () => app.quit());
}
