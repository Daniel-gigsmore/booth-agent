const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kachak", {
  minimize: () => ipcRenderer.send("minimize"),
  close: () => ipcRenderer.send("close"),
});
