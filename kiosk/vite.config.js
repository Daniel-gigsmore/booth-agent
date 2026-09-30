import { execFile } from "node:child_process";
import { defineConfig } from "vite";

// A web page can't minimize its own window, but `vite preview` runs in the
// logged-in user's session (start-kiosk.ps1), so it can. The operator panel's
// "Minimize kiosk" button POSTs here while the kiosk is the foreground window.
const MINIMIZE_FOREGROUND = `
Add-Type -Namespace Kachak -Name Win -MemberDefinition '
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);'
[Kachak.Win]::ShowWindowAsync([Kachak.Win]::GetForegroundWindow(), 6) | Out-Null`;

export default defineConfig({
  plugins: [
    {
      name: "kachak-minimize",
      configurePreviewServer(server) {
        server.middlewares.use("/__minimize", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end();
            return;
          }
          execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", MINIMIZE_FOREGROUND], (err) => {
            res.statusCode = err ? 500 : 204;
            res.end();
          });
        });
      },
    },
  ],
});
