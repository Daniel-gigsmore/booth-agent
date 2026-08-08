import path from "node:path";
import { spawn } from "node:child_process";
import SysTray from "systray2";
import { ConfigStore } from "../config/config";
import { renderStatusIconBase64, TrayStatusColor } from "./icon";
import { createLogger } from "../util/logger";

const log = createLogger("tray");

/**
 * Optional visual companion to the BoothAgent Windows service. This process
 * does NOT run the camera/printer/outbox itself - it only polls the already
 * running agent's /health endpoint and reflects status in the tray icon.
 * Quitting the tray does not stop the service; the booth keeps working
 * either way.
 */
async function main(): Promise<void> {
  const configPath = process.env["BOOTH_CONFIG_PATH"] ?? path.resolve(process.cwd(), "booth.config.json");
  const configStore = ConfigStore.load(configPath);
  configStore.watch();

  const initialIcon = await renderStatusIconBase64("gray");
  const systray = new SysTray({
    menu: {
      icon: initialIcon,
      title: "Booth Agent",
      tooltip: "Booth Agent - starting...",
      items: [
        { title: "Booth Agent", tooltip: "", enabled: false },
        SysTray.separator,
        { title: "Checking status...", tooltip: "", enabled: false },
        SysTray.separator,
        { title: "Open Data Folder", tooltip: "Open the local capture/outbox folder", enabled: true },
        { title: "Quit tray (agent keeps running)", tooltip: "", enabled: true },
      ],
    },
    debug: false,
  });

  systray.onClick((action) => {
    if (action.item.title === "Open Data Folder") {
      spawn("explorer.exe", [configStore.current.storage.dataDir], { detached: true });
    }
    if (action.item.title.startsWith("Quit tray")) {
      void systray.kill(true);
    }
  });

  const poll = async (): Promise<void> => {
    const { port, sharedSecret } = configStore.current.agent;
    let statusLine = "Agent unreachable";
    let color: TrayStatusColor = "red";

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${sharedSecret}` },
      });
      if (response.ok) {
        const health = (await response.json()) as {
          camera: { activeSource: string; preference: string };
          hotFolder: { writable: boolean };
          outbox: { queueDepth: number; lastError: string | null };
        };
        const cameraOk = health.camera.activeSource !== "none";
        const onPreferred = health.camera.activeSource === health.camera.preference;
        const hotFolderOk = health.hotFolder.writable;

        if (!cameraOk || !hotFolderOk) {
          color = "red";
        } else if (!onPreferred || health.outbox.lastError) {
          color = "amber";
        } else {
          color = "green";
        }
        statusLine = `Camera: ${health.camera.activeSource} | Hot folder: ${
          hotFolderOk ? "ok" : "UNWRITABLE"
        } | Outbox: ${health.outbox.queueDepth} pending`;
      }
    } catch (err) {
      log.debug("Health poll failed", err);
    }

    const icon = await renderStatusIconBase64(color);
    await systray.sendAction({
      type: "update-menu",
      menu: {
        icon,
        title: "Booth Agent",
        tooltip: statusLine,
        items: [
          { title: "Booth Agent", tooltip: "", enabled: false },
          SysTray.separator,
          { title: statusLine, tooltip: "", enabled: false },
          SysTray.separator,
          { title: "Open Data Folder", tooltip: "Open the local capture/outbox folder", enabled: true },
          { title: "Quit tray (agent keeps running)", tooltip: "", enabled: true },
        ],
      },
    });
  };

  await systray.ready();
  await poll();
  setInterval(() => void poll(), 3000);
}

main().catch((err) => {
  log.error("Tray app failed to start", err);
  process.exit(1);
});
