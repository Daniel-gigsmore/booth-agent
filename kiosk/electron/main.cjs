const { app, BrowserWindow, ipcMain, dialog } = require("electron");
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

async function start() {
  try {
    await serve();
  } catch (e) {
    dialog.showErrorBox("Kachak Kiosk", `Port ${PORT} is busy (old start-kiosk.ps1 still running?).\n\n${e.message}`);
    app.quit();
    return;
  }
  win = new BrowserWindow({
    kiosk: true,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  win.loadURL(KIOSK_URL);
}

ipcMain.on("minimize", () => win?.minimize());
ipcMain.on("close", () => win?.close());

if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
app.whenReady().then(start);
app.on("window-all-closed", () => app.quit());
