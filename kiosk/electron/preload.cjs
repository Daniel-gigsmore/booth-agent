const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kachak", {
  minimize: () => ipcRenderer.send("minimize"),
  close: () => ipcRenderer.send("close"),
  // { agentUrl, token, downloadUrl } from booth.config.json, or null to use the values built in.
  config: ipcRenderer.sendSync("config"),
  // Resolves to an error message for the operator, or null once the slideshow is open.
  openSlideshow: (url) => ipcRenderer.invoke("open-slideshow", url),
});
