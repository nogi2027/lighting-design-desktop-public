/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, Menu, dialog, screen, session, shell, protocol } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { WORKSPACE_URL, isWorkspaceUrl, isExternalUrl, cacheDesktopAssets, restoreBounds } = require("./helpers.cjs");

app.setName(process.env.LX_DESKTOP_CORPUS ? "Lighting Reading Lab" : "Lighting Design Desktop");
const workspace = require("./workspace.cjs");
const hiddenTests = process.env.LX_DESKTOP_TEST_HIDE_WINDOWS === "1";
const backgroundLaunch = process.env.LX_DESKTOP_START_IN_BACKGROUND === "1";
protocol.registerSchemesAsPrivileged([{ scheme:"app", privileges:{ standard:true, secure:true, supportFetchAPI:true, corsEnabled:true, stream:true } }]);
// Smoke tests use a disposable profile, separate from the user's workspace cache.
if ((process.env.LX_DESKTOP_USER_DATA || process.env.LT_DESKTOP_USER_DATA)) {
  fs.mkdirSync((process.env.LX_DESKTOP_USER_DATA || process.env.LT_DESKTOP_USER_DATA), { recursive: true });
  app.setPath("userData", path.resolve((process.env.LX_DESKTOP_USER_DATA || process.env.LT_DESKTOP_USER_DATA)));
}

const statePath = path.join(app.getPath("userData"), "desktop-state.json");
let state = {};
try {
  const value = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (value && typeof value === "object" && !Array.isArray(value)) state = value;
} catch { /* First launch or damaged preferences: use the defaults. */ }
let mainWindow;

function saveState() {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
    fs.renameSync(`${statePath}.tmp`, statePath);
  } catch (error) { console.error("Could not save desktop preferences:", error.message); }
}

function message(options) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

function openExternal(url) {
  if (isExternalUrl(url)) void shell.openExternal(url).catch((error) => {
    void message({ type: "error", message: "Couldn’t open the link", detail: error.message });
  });
}

function loadWorkspace() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else void mainWindow.loadURL(WORKSPACE_URL).catch(() => {}); // did-fail-load shows recovery.
}

function setupSession() {
  // Open the TLS connection while menus/window setup runs.
  if (WORKSPACE_URL.startsWith("https:")) session.defaultSession.preconnect({ url: WORKSPACE_URL, numSockets: 2 });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({cancel: !details.url.startsWith("app://desktop/") && !details.url.startsWith("blob:app://desktop/") && !details.url.startsWith("data:")}));
  const trusted = (contents, permission, url) => contents && isWorkspaceUrl(contents.getURL()) && isWorkspaceUrl(url)
    && ["clipboard-sanitized-write", "fullscreen"].includes(permission);
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => trusted(contents, permission, origin));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(!!trusted(contents, permission, details.requestingUrl));
  });

  const downloads = new Set();
  function showProgress() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const total = [...downloads].reduce((sum, item) => sum + item.getTotalBytes(), 0);
    const received = [...downloads].reduce((sum, item) => sum + item.getReceivedBytes(), 0);
    mainWindow.setProgressBar(!downloads.size ? -1 : total ? received / total : 2);
  }
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath("downloads"), path.basename(item.getFilename())) });
    downloads.add(item);
    item.on("updated", showProgress);
    showProgress();
    item.once("done", async (_event, status) => {
      downloads.delete(item);
      showProgress();
      if (status === "completed") {
        const { response } = await message({ type: "info", message: `Saved ${item.getFilename()}`,
          detail: item.getSavePath(), buttons: ["Show in Finder", "Done"], defaultId: 1, cancelId: 1 });
        if (response === 0) shell.showItemInFolder(item.getSavePath());
      } else if (status !== "cancelled") {
        await message({ type: "warning", message: "Download didn’t finish", detail: "Check your connection and try exporting again." });
      }
    });
  });
}

function createWindow() {
  const window = new BrowserWindow({
    ...restoreBounds(state.window ?? {}, [screen.getPrimaryDisplay(), ...screen.getAllDisplays()]),
    title: "Lighting Design Desktop",
    backgroundColor: "#101116",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname,"preload.cjs"),
      backgroundThrottling: !hiddenTests,
    },
  });
  mainWindow = window;
  workspace.attach(window);
  const contents = window.webContents;
  if (state.zoom >= 0.5 && state.zoom <= 3) contents.setZoomFactor(state.zoom);
  if (state.maximized) window.maximize();
  let recovering = false;
  function showRecovery() {
    if (recovering || window.isDestroyed()) return;
    recovering = true;
    void window.loadFile(path.join(__dirname, "unavailable.html")).catch(console.error);
    if (!hiddenTests) window.show();
  }
  window.once("ready-to-show", () => { if (!hiddenTests) { if(backgroundLaunch) window.showInactive(); else window.show(); } });
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && isWorkspaceUrl(url)) showRecovery();
  });
  contents.on("render-process-gone", showRecovery);
  contents.on("did-finish-load", () => {
    if (isWorkspaceUrl(contents.getURL())) {
      recovering = false;
      void contents.executeJavaScript(`(${cacheDesktopAssets.toString()})()`).catch(() => {});
    }
  });
  window.on("close", () => {
    state.window = window.getNormalBounds();
    state.maximized = window.isMaximized();
    state.zoom = contents.getZoomFactor();
    saveState();
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isWorkspaceUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.on("will-redirect", (event, url) => {
    if (!isWorkspaceUrl(url)) event.preventDefault();
  });
  void window.loadURL(WORKSPACE_URL).catch(() => {});
}

function setupMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ] },
    { label: "File", submenu: [
      { label: "New Show", accelerator: "CmdOrCtrl+N", click: () => workspace.command("new") },
      { label: "Open Show…", accelerator:"CmdOrCtrl+O", click:() => workspace.command("open") },
      { label: "Save", accelerator:"CmdOrCtrl+S", click:() => workspace.command("save") },
      { label: "Save As…", accelerator:"CmdOrCtrl+Shift+S", click:() => workspace.command("save-as") },
      { role: "close" },
    ] },
    { label: "Edit", submenu: [
      { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => workspace.command("undo") },
      { label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", click: () => workspace.command("redo") },
      { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ] },
    { label: "View", submenu: [
      { label: "Reload Workspace", accelerator: "CmdOrCtrl+R", click: loadWorkspace },
      { role: "forceReload" }, { type: "separator" },
      { role: "resetZoom", label: "Reset Interface Zoom" }, { role: "zoomIn", label: "Interface Zoom In" }, { role: "zoomOut", label: "Interface Zoom Out" },
      { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { role: "windowMenu" },
    { role: "help", submenu: [
      { label: "About Lighting Design Desktop", role: "about" },
    ] },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!mainWindow) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!hiddenTests) { mainWindow.show(); mainWindow.focus(); }
  });
  app.whenReady().then(async () => {
    if (hiddenTests && process.platform === "darwin") app.setActivationPolicy("prohibited");
    await workspace.setup();
    setupSession();
    setupMenu();
    createWindow();
    app.on("activate", () => { if (!mainWindow) createWindow(); });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
