const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("interfaceCanvasDesktop", {
    isElectron: true,
    wuxinAuth: (spec) => ipcRenderer.invoke("wuxin-auth", spec),
    getCanvasAgentInfo: () => ipcRenderer.invoke("canvas-agent:getInfo"),
    ensureCanvasAgentStarted: () => ipcRenderer.invoke("canvas-agent:ensureStarted"),
    setCanvasAgentAiConfig: (ai) => ipcRenderer.invoke("canvas-agent:setAiConfig", ai),
    loadSession: () => ipcRenderer.invoke("session:load"),
    saveSession: (session) => ipcRenderer.invoke("session:save", session),
    clearSession: () => ipcRenderer.invoke("session:clear"),
    notifyAppShellReady: () => ipcRenderer.invoke("app-shell:ready"),
    getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
    checkForUpdate: () => ipcRenderer.invoke("update:check"),
    downloadAndInstallUpdate: () => ipcRenderer.invoke("update:downloadAndInstall"),
    getUpdateStatus: () => ipcRenderer.invoke("update:getStatus"),
    onUpdateProgress: (handler) => {
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on("update:progress", listener);
        return () => ipcRenderer.removeListener("update:progress", listener);
    },
});
