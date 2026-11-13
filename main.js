// NSZ Booking for Mac and Windows. A window around the live app, plus the desktop powers a
// browser tab doesn't have: screen sharing with a picker, sound from any app, and its own Dock icon.
const { app, BrowserWindow, session, desktopCapturer, shell, systemPreferences, ipcMain, Menu } = require("electron");
const path = require("path");

const APP_URL = "https://nsz-booking-lilac.vercel.app";
const HOME = `${APP_URL}/admin`;
const isMac = process.platform === "darwin";

// Google blocks sign in from apps that say "Electron" in their name tag, so look like plain Chrome.
app.userAgentFallback = app.userAgentFallback.replace(/\s*Electron\/\S+/, "").replace(/\s*nsz-booking-desktop\/\S+/i, "").replace(/\s*NSZ Booking\/\S+/i, "");

// Lets screen share carry computer sound on Macs too (Serato, Spotify, any app), not just Windows.
if (isMac) app.commandLine.appendSwitch("enable-features", "MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride");

let win;
const allowedHosts = new Set([new URL(APP_URL).host, "accounts.google.com", "checkout.stripe.com"]);

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 380,
    minHeight: 560,
    title: "NSZ Booking",
    backgroundColor: "#FAFAF9",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.loadURL(HOME);

  // Links to other sites (YouTube, your website, Google Calendar) open in your normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isOurs(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

function isOurs(url) {
  try {
    const h = new URL(url).host;
    return allowedHosts.has(h) || h.endsWith(".google.com") || h.endsWith(".googleusercontent.com");
  } catch {
    return false;
  }
}

// Screen sharing: show our own picker of screens and windows, then share the one you pick.
// Only the picker window may list your screens, never the website.
let picker = null;
let pickResolve = null;
ipcMain.handle("picker:sources", async (e) => {
  if (!picker || e.sender !== picker.webContents) return [];
  const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } });
  return sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
});
ipcMain.on("picker:choose", (e, id) => {
  if (picker && e.sender === picker.webContents && pickResolve) pickResolve(id || null);
});

function pickSource() {
  return new Promise((resolve) => {
    let settled = false;
    picker = new BrowserWindow({
      parent: win,
      modal: true,
      width: 760,
      height: 560,
      title: "Share your screen",
      backgroundColor: "#18181B",
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
    });
    const finish = (id) => {
      if (settled) return;
      settled = true;
      pickResolve = null;
      const p = picker;
      picker = null;
      if (p && !p.isDestroyed()) p.close();
      resolve(id);
    };
    pickResolve = finish;
    picker.on("closed", () => finish(null));
    picker.setMenuBarVisibility(false);
    picker.loadFile(path.join(__dirname, "picker.html"));
  });
}

app.whenReady().then(async () => {
  if (isMac) {
    // Ask once for camera and mic so calls just work.
    try {
      await systemPreferences.askForMediaAccess("camera");
      await systemPreferences.askForMediaAccess("microphone");
    } catch {}
  }

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ok = ["media", "display-capture", "notifications", "clipboard-sanitized-write", "clipboard-read", "fullscreen", "speaker-selection"].includes(permission);
    cb(ok && isOurs(details.requestingUrl || wc.getURL()));
  });
  // Lets the call page list every camera, mic, mixer and speaker by name.
  ses.setPermissionCheckHandler((wc, permission, origin) => isOurs(origin || wc?.getURL() || ""));
  ses.setDevicePermissionHandler?.((details) => isOurs(details.origin || ""));

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const id = await pickSource();
      if (!id) return callback({});
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
      const chosen = sources.find((s) => s.id === id);
      if (!chosen) return callback({});
      // Computer sound from every app (Serato, Spotify, videos) goes with the screen when you ask for it.
      callback({ video: chosen, ...(request.audioRequested ? { audio: "loopback" } : {}) });
    } catch {
      callback({});
    }
  });

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", click: () => win?.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => win?.webContents.navigationHistory.canGoForward() && win.webContents.navigationHistory.goForward() },
        { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: () => win?.loadURL(HOME) },
        { role: "reload" },
        { role: "togglefullscreen" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

// Open call links (nszbooking://call/ROOM) straight into the app.
app.setAsDefaultProtocolClient("nszbooking");
app.on("open-url", (e, url) => {
  e.preventDefault();
  const p = url.replace(/^nszbooking:\/\//, "");
  if (win) win.loadURL(`${APP_URL}/${p}`);
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
