const { contextBridge, ipcRenderer } = require("electron");

// Only the screen picker uses this. The app itself runs like a normal website.
contextBridge.exposeInMainWorld("nszDesktop", {
  isDesktop: true,
  sources: () => ipcRenderer.invoke("picker:sources"),
  choose: (id) => ipcRenderer.send("picker:choose", id),
});
