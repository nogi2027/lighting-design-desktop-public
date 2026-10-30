/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");
const invoke = (channel, ...args) =>
  ipcRenderer.invoke(`desktop:${channel}`, ...args);
contextBridge.exposeInMainWorld("desktop", {
  session: () => invoke("session"),
  newShow: () => invoke("new"),
  openPdf: () => invoke("open-pdf"),
  example: (id) => invoke("example", id),
  examples: () => invoke("examples"),
  recent: () => invoke("recent"),
  recovery: () => invoke("recovery"),
  openShow: (path) => invoke("open-show", path),
  recover: (id) => invoke("recover", id),
  finishImport: (state, reading) => invoke("finish-import", state, reading),
  save: (as) => invoke("save", as),
  onCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("desktop-command", listener);
    return () => ipcRenderer.removeListener("desktop-command", listener);
  },
});
