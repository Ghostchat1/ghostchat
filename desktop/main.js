// GhostChat desktop. A locked-down window onto https://quietline.chat/app.
// No Node.js in the page, no access to your files except through the normal save dialog,
// screenshots and screen-recording blocked on Windows and macOS, nothing stored outside the app's own folder.
const { app, BrowserWindow, session, shell, Menu } = require("electron");
const HOST = "quietline.chat", HOME = `https://${HOST}/app`;
const sameSite = (u) => { try { const x = new URL(u); return x.protocol === "https:" && x.hostname === HOST; } catch { return false; } };

app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp"); // calls go via the relay only
app.commandLine.appendSwitch("webrtc-ip-handling-policy", "disable_non_proxied_udp");
if (!app.requestSingleInstanceLock()) app.quit();

let win;
function create() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 380, minHeight: 560, backgroundColor: "#0b0b0c", title: "GhostChat", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false, preload: require("path").join(__dirname, "preload.js") },
  });
  win.setContentProtection(true); // blocks screenshots / screen recording of the window (Windows 10 2004+, macOS)
  win.loadURL(HOME);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https|mailto):/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!sameSite(url)) { e.preventDefault(); if (/^(https|mailto):/i.test(url)) shell.openExternal(url); } });
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
}
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null);
  const s = session.defaultSession;
  // camera / microphone / notifications only for GhostChat itself; everything else refused
  const ok = new Set(["media", "notifications", "clipboard-sanitized-write", "fullscreen"]);
  s.setPermissionRequestHandler((wc, perm, cb, d) => cb(ok.has(perm) && sameSite(d.requestingUrl || wc.getURL())));
  s.setPermissionCheckHandler((wc, perm, origin) => ok.has(perm) && sameSite(origin));
  s.on("will-download", (e, item) => item.setSaveDialogOptions({ title: "Save file from GhostChat" }));
  app.on("web-contents-created", (e, wc) => wc.on("will-navigate", (ev, url) => { if (!sameSite(url)) ev.preventDefault(); }));
  create();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) create(); });
});
app.on("window-all-closed", () => app.quit());
