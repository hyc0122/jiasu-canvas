const { app, BrowserWindow, Menu, shell, ipcMain, net, session } = require("electron");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
    registerUpdateIpc,
    tryApplyPendingOnStartup,
} = require("./updater.cjs");

const isMac = process.platform === "darwin";
const WUXIN_CONSOLE = "https://www.wuxin-ai.xyz";
const DEFAULT_AGENT_PORT = 17371;

app.setName("佳速画布");
app.setAppUserModelId("com.jiasuapi.jiasu-canvas");

/** @type {{ url: string; token: string; started: boolean; error?: string; port: number }} */
let canvasAgentInfo = {
    url: `http://127.0.0.1:${DEFAULT_AGENT_PORT}`,
    token: "",
    started: false,
    port: DEFAULT_AGENT_PORT,
};
/** @type {Promise<typeof canvasAgentInfo> | null} */
let canvasAgentStartPromise = null;
/** @type {import("node:child_process").ChildProcess | null} */
let agentChild = null;

function mainLogPath() {
    return path.join(app.getPath("userData"), "main.log");
}

function agentLogPath() {
    return path.join(app.getPath("userData"), "agent.log");
}

function appendMainLog(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
        fs.mkdirSync(path.dirname(mainLogPath()), { recursive: true });
        fs.appendFileSync(mainLogPath(), line);
    } catch {
        // logging is best-effort
    }
    console.error(`[jiasu-canvas] ${message}`);
}

function sessionFilePath() {
    return path.join(app.getPath("userData"), "session.json");
}

function readSessionFile() {
    try {
        const data = JSON.parse(fs.readFileSync(sessionFilePath(), "utf8"));
        if (!data || typeof data !== "object") return null;
        return data;
    } catch {
        return null;
    }
}

function writeSessionFile(patch = {}) {
    const current = readSessionFile() || {};
    const next = {
        username: patch.username !== undefined ? String(patch.username || "") : String(current.username || ""),
        password: patch.password !== undefined ? String(patch.password || "") : String(current.password || ""),
        user: patch.user !== undefined ? patch.user : current.user || null,
        accessToken: patch.accessToken !== undefined ? String(patch.accessToken || "") : String(current.accessToken || ""),
        accessExpiresAt: patch.accessExpiresAt !== undefined ? Number(patch.accessExpiresAt) || 0 : Number(current.accessExpiresAt) || 0,
        cookies: patch.cookies !== undefined ? patch.cookies : (Object.keys(wuxinCookies).length ? wuxinCookies : current.cookies || {}),
    };
    const file = sessionFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
    try {
        fs.chmodSync(file, 0o600);
    } catch {
        // Windows may ignore chmod.
    }
    return next;
}

function clearSessionFile() {
    try {
        fs.unlinkSync(sessionFilePath());
    } catch {
        // already gone
    }
}

/** @type {Record<string, { value: string; path?: string }>} */
let wuxinCookies = {};

function loadCookiesFromSession() {
    const stored = readSessionFile();
    if (stored?.cookies && typeof stored.cookies === "object") {
        wuxinCookies = { ...stored.cookies };
    }
}

function cookieHeader() {
    return Object.entries(wuxinCookies)
        .filter(([, cookie]) => cookie && cookie.value)
        .map(([name, cookie]) => `${name}=${cookie.value}`)
        .join("; ");
}

function readSetCookies(response) {
    try {
        if (response.headers && typeof response.headers.getSetCookie === "function") {
            const list = response.headers.getSetCookie();
            if (Array.isArray(list) && list.length) return list;
        }
    } catch {
        // fall through
    }
    const raw = response.headers ? response.headers.get("set-cookie") : "";
    if (!raw) return [];
    return String(raw).split(/,(?=[^ ;]+=)/);
}

function applySetCookieHeaders(response) {
    const lines = readSetCookies(response);
    if (!lines.length) return;
    for (const line of lines) {
        const [nv, ...attrs] = String(line).split(";");
        const eq = nv.indexOf("=");
        if (eq < 0) continue;
        const name = nv.slice(0, eq).trim();
        const value = nv.slice(eq + 1).trim();
        if (!name) continue;
        const attrMap = {};
        for (const attr of attrs) {
            const [key, ...rest] = attr.split("=");
            attrMap[String(key || "").trim().toLowerCase()] = rest.length ? rest.join("=").trim() : true;
        }
        if (value === "" || attrMap["max-age"] === "0") {
            delete wuxinCookies[name];
            continue;
        }
        wuxinCookies[name] = { value, path: typeof attrMap.path === "string" ? attrMap.path : "/" };
    }
    const current = readSessionFile() || {};
    writeSessionFile({ ...current, cookies: wuxinCookies });
}

async function applyCookiesToElectronSession() {
    const ses = session.defaultSession;
    for (const [name, cookie] of Object.entries(wuxinCookies)) {
        if (!cookie?.value) continue;
        try {
            await ses.cookies.set({
                url: WUXIN_CONSOLE,
                name,
                value: cookie.value,
                path: cookie.path || "/",
                secure: true,
                httpOnly: true,
            });
        } catch {
            // cookie restore is best-effort
        }
    }
}

function rendererIndex() {
    return path.join(__dirname, "..", "web-dist", "index.html");
}

function windowIcon() {
    const icon = path.join(__dirname, "icon.png");
    return fs.existsSync(icon) ? icon : undefined;
}

function canvasAgentConfigDir() {
    return path.join(app.getPath("userData"), "canvas-agent");
}

function canvasAgentConfigFile() {
    return path.join(canvasAgentConfigDir(), "canvas-agent.json");
}

function resolveCanvasAgentRoot() {
    const packed = path.join(process.resourcesPath, "canvas-agent");
    if (fs.existsSync(path.join(packed, "dist", "server", "http.js"))) return packed;
    const dev = path.join(__dirname, "..", "..", "canvas-agent");
    if (fs.existsSync(path.join(dev, "dist", "server", "http.js"))) return dev;
    return packed;
}

function readCanvasAgentConfig() {
    try {
        return JSON.parse(fs.readFileSync(canvasAgentConfigFile(), "utf8"));
    } catch {
        return null;
    }
}

function writeCanvasAgentConfig(config) {
    const dir = canvasAgentConfigDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = canvasAgentConfigFile();
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    try {
        fs.chmodSync(dir, 0o700);
        fs.chmodSync(file, 0o600);
    } catch {
        // Windows may ignore chmod; config still works.
    }
}

function resolveAgentPort() {
    const existing = readCanvasAgentConfig();
    const fromUrl = existing?.url ? Number(new URL(existing.url).port) : NaN;
    if (Number.isFinite(fromUrl) && fromUrl > 0) return fromUrl;
    return DEFAULT_AGENT_PORT;
}

async function waitForAgentHealth(port, timeoutMs = 12000) {
    const startedAt = Date.now();
    let lastError = "";
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await net.fetch(`http://127.0.0.1:${port}/health`);
            if (response.ok) return;
            lastError = `health status ${response.status}`;
        } catch (error) {
            lastError = error && error.message ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(lastError || "canvas-agent health timeout");
}

function stopCanvasAgentChild() {
    if (!agentChild || agentChild.killed) {
        agentChild = null;
        return;
    }
    const child = agentChild;
    agentChild = null;
    try {
        child.kill();
    } catch (error) {
        appendMainLog(`failed to kill canvas-agent child: ${error && error.message ? error.message : String(error)}`);
    }
}

async function startCanvasAgent() {
    if (canvasAgentInfo.started) return canvasAgentInfo;
    if (canvasAgentStartPromise) return canvasAgentStartPromise;

    canvasAgentStartPromise = (async () => {
        const port = resolveAgentPort();
        const configDir = canvasAgentConfigDir();
        const agentRoot = resolveCanvasAgentRoot();
        const indexEntry = path.join(agentRoot, "dist", "index.js");
        if (!fs.existsSync(indexEntry)) {
            const error = `canvas-agent entry missing: ${indexEntry}`;
            appendMainLog(error);
            canvasAgentInfo = { url: `http://127.0.0.1:${port}`, token: "", started: false, error, port };
            return canvasAgentInfo;
        }

        stopCanvasAgentChild();

        try {
            fs.mkdirSync(app.getPath("userData"), { recursive: true });
            const logStream = fs.createWriteStream(agentLogPath(), { flags: "a" });
            const childEnv = {
                ...process.env,
                ELECTRON_RUN_AS_NODE: "1",
                AICOST_EMBEDDED_AGENT: "1",
                CANVAS_AGENT_MODE: "lightweight",
                CANVAS_AGENT_CONFIG_DIR: configDir,
                PORT: String(port),
            };
            // Never inherit a random parent shell PORT into the child.
            childEnv.PORT = String(port);

            const child = spawn(process.execPath, [indexEntry], {
                cwd: agentRoot,
                env: childEnv,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            agentChild = child;
            child.stdout.pipe(logStream);
            child.stderr.pipe(logStream);
            child.on("error", (error) => {
                appendMainLog(`canvas-agent child error: ${error && error.message ? error.message : String(error)}`);
            });
            child.on("exit", (code, signal) => {
                if (agentChild === child) agentChild = null;
                if (canvasAgentInfo.started) {
                    appendMainLog(`canvas-agent child exited code=${code} signal=${signal}`);
                    canvasAgentInfo = { ...canvasAgentInfo, started: false, error: `agent exited (${code ?? signal})` };
                }
                try {
                    logStream.end();
                } catch {
                    // ignore
                }
            });

            await waitForAgentHealth(port);
            const config = readCanvasAgentConfig() || {};
            const token = String(config.token || "");
            const url = String(config.url || `http://127.0.0.1:${port}`);
            canvasAgentInfo = { url, token, started: true, port };
            console.log(`[jiasu-canvas] canvas-agent ready at ${url}`);
            return canvasAgentInfo;
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            appendMainLog(`canvas-agent start failed: ${message}`);
            stopCanvasAgentChild();
            canvasAgentInfo = {
                url: `http://127.0.0.1:${port}`,
                token: "",
                started: false,
                error: message,
                port,
            };
            return canvasAgentInfo;
        }
    })();

    try {
        return await canvasAgentStartPromise;
    } finally {
        if (!canvasAgentInfo.started) canvasAgentStartPromise = null;
    }
}

function getCanvasAgentInfo() {
    if (canvasAgentInfo.started && !canvasAgentInfo.token) {
        const config = readCanvasAgentConfig();
        if (config?.token) canvasAgentInfo = { ...canvasAgentInfo, token: String(config.token), url: String(config.url || canvasAgentInfo.url) };
    }
    return {
        url: canvasAgentInfo.url,
        token: canvasAgentInfo.token,
        started: canvasAgentInfo.started,
        ...(canvasAgentInfo.error ? { error: canvasAgentInfo.error } : {}),
    };
}

function setCanvasAgentAiConfig(ai = {}) {
    const port = canvasAgentInfo.port || resolveAgentPort();
    const existing = readCanvasAgentConfig() || {};
    const next = {
        ...existing,
        url: existing.url || `http://127.0.0.1:${port}`,
        token: existing.token || crypto.randomBytes(18).toString("hex"),
        ai: {
            ...(existing.ai && typeof existing.ai === "object" ? existing.ai : {}),
            ...(typeof ai.baseUrl === "string" ? { baseUrl: ai.baseUrl } : {}),
            ...(typeof ai.apiKey === "string" ? { apiKey: ai.apiKey } : {}),
            ...(typeof ai.textModel === "string" ? { textModel: ai.textModel } : {}),
            ...(Array.isArray(ai.textModels) ? { textModels: ai.textModels.map(String) } : {}),
            ...(typeof ai.systemPrompt === "string" ? { systemPrompt: ai.systemPrompt } : {}),
        },
    };
    writeCanvasAgentConfig(next);
    if (!canvasAgentInfo.token) canvasAgentInfo = { ...canvasAgentInfo, token: next.token, url: next.url };
    return { ok: true };
}

ipcMain.handle("wuxin-auth", async (_event, spec = {}) => {
    const method = String(spec.method || "GET").toUpperCase();
    const route = String(spec.path || "");
    if (!route.startsWith("/api/")) {
        return { status: 400, data: { success: false, message: "invalid auth path" } };
    }

    const url = new URL(route, WUXIN_CONSOLE);
    if (spec.params && typeof spec.params === "object") {
        for (const [key, value] of Object.entries(spec.params)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
    }

    const headers = {
        Accept: "application/json",
        ...(spec.body ? { "Content-Type": "application/json" } : {}),
        ...(spec.headers && typeof spec.headers === "object" ? spec.headers : {}),
    };
    const jar = cookieHeader();
    if (jar && !headers.Cookie && !headers.cookie) headers.Cookie = jar;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await net.fetch(url.toString(), {
            method,
            headers,
            body: spec.body ? JSON.stringify(spec.body) : undefined,
            signal: controller.signal,
            session: session.defaultSession,
        });
        applySetCookieHeaders(response);
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { success: false, message: text || `HTTP ${response.status}` };
        }
        return { status: response.status, data };
    } catch (error) {
        const message = error && error.name === "AbortError" ? "网络超时，请稍后重试" : (error && error.message) || "网络异常，请检查连接后重试";
        return { status: 0, data: { success: false, message } };
    } finally {
        clearTimeout(timer);
    }
});

ipcMain.handle("canvas-agent:getInfo", async () => getCanvasAgentInfo());
ipcMain.handle("canvas-agent:ensureStarted", async () => {
    await startCanvasAgent();
    return getCanvasAgentInfo();
});
ipcMain.handle("canvas-agent:setAiConfig", async (_event, ai) => setCanvasAgentAiConfig(ai || {}));
ipcMain.handle("session:load", async () => readSessionFile());
ipcMain.handle("session:save", async (_event, payload = {}) => {
    const next = writeSessionFile(payload && typeof payload === "object" ? payload : {});
    if (next.cookies && typeof next.cookies === "object") wuxinCookies = { ...next.cookies };
    return { ok: true };
});
ipcMain.handle("session:clear", async () => {
    wuxinCookies = {};
    clearSessionFile();
    return { ok: true };
});


/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;

registerUpdateIpc(() => mainWindow);

function splashHtmlPath() {
    return path.join(__dirname, "splash.html");
}

function createSplashWindow() {
    const splash = new BrowserWindow({
        width: 520,
        height: 420,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        frame: false,
        show: true,
        center: true,
        alwaysOnTop: true,
        title: "佳速画布",
        icon: windowIcon(),
        backgroundColor: "#ffffff",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });
    splash.setMenuBarVisibility(false);
    splash.loadFile(splashHtmlPath());
    splashWindow = splash;
    return splash;
}

function closeSplashWindow() {
    if (!splashWindow) return;
    try {
        if (!splashWindow.isDestroyed()) splashWindow.close();
    } catch {
        // ignore
    }
    splashWindow = null;
}

async function waitSplashDomReady(splash, timeoutMs = 4000) {
    if (!splash || splash.isDestroyed()) return;
    if (!splash.webContents.isLoading()) return;
    await Promise.race([
        new Promise((resolve) => splash.webContents.once("did-finish-load", resolve)),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}

/**
 * @param {BrowserWindow | null} splash
 * @param {{ steps?: string[]; percent?: number; subtitle?: string }} payload
 */
async function updateSplash(splash, payload) {
    if (!splash || splash.isDestroyed()) return;
    try {
        await splash.webContents.executeJavaScript(`window.__splashUpdate && window.__splashUpdate(${JSON.stringify(payload)})`);
    } catch {
        // splash updates are best-effort
    }
}

async function runColdStartSplash(splash) {
    /** @type {string[]} */
    const steps = ["wait", "wait", "wait", "wait"];
    const apply = async (index, state, subtitle) => {
        steps[index] = state;
        for (let i = 0; i < index; i += 1) {
            if (steps[i] === "wait" || steps[i] === "now") steps[i] = "done";
        }
        const doneCount = steps.filter((s) => s === "done" || s === "fail").length;
        const nowBonus = steps.includes("now") ? 0.5 : 0;
        const percent = Math.round(((doneCount + nowBonus) / steps.length) * 100);
        await updateSplash(splash, { steps: [...steps], percent, subtitle });
    };

    // 1. 检查运行环境
    await apply(0, "now", "检查运行环境");
    const indexHtml = rendererIndex();
    const envOk = Boolean(process.versions.node && process.versions.electron && fs.existsSync(path.dirname(indexHtml)));
    await apply(0, envOk ? "done" : "fail", envOk ? "运行环境就绪" : "运行环境异常");

    // 2. 启动画布服务（失败不阻塞）
    await apply(1, "now", "启动画布服务");
    let agentOk = false;
    try {
        const info = await Promise.race([
            startCanvasAgent(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("canvas-agent splash timeout")), 12000)),
        ]);
        agentOk = Boolean(info && info.started);
    } catch (error) {
        appendMainLog(`splash agent step: ${error && error.message ? error.message : String(error)}`);
        agentOk = false;
    }
    await apply(1, agentOk ? "done" : "fail", agentOk ? "画布服务已就绪" : "画布服务稍后重试");

    // 3. 加载界面资源
    await apply(2, "now", "加载界面资源");
    const uiOk = fs.existsSync(indexHtml);
    await apply(2, uiOk ? "done" : "fail", uiOk ? "界面资源已就绪" : "缺少界面资源");

    // 4. 打开工作台 — createWindow + ready-to-show handled by caller
    await apply(3, "now", "打开工作台");
    return { indexHtml, uiOk, steps };
}

function createWindow() {
    const indexHtml = rendererIndex();
    if (!fs.existsSync(indexHtml)) {
        console.error(`[jiasu-canvas] missing ${indexHtml}. Run \`npm run build:web\` in desktop/ first.`);
        closeSplashWindow();
        app.quit();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 960,
        minHeight: 640,
        title: "佳速画布",
        icon: windowIcon(),
        show: false,
        autoHideMenuBar: true,
        backgroundColor: "#1c1917",
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // file:// pages are a null origin; disable webSecurity so the same
            // OpenAI-compatible API calls the browser SPA makes are not blocked by CORS.
            webSecurity: false,
            spellcheck: false,
        },
    });

    mainWindow.once("ready-to-show", () => {
        void (async () => {
            await updateSplash(splashWindow, {
                steps: ["done", "done", "done", "done"],
                percent: 100,
                subtitle: "工作台已就绪",
            });
            closeSplashWindow();
            mainWindow?.show();
        })();
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("https:") || url.startsWith("http:")) {
            shell.openExternal(url);
        }
        return { action: "deny" };
    });

    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (url.startsWith("file:")) return;
        event.preventDefault();
        if (url.startsWith("https:") || url.startsWith("http:")) {
            shell.openExternal(url);
        }
    });

    mainWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
        console.error(`[jiasu-canvas] failed to load ${url}: ${code} ${desc}`);
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    mainWindow.loadFile(indexHtml);
}

function installMenu() {
    const template = [
        ...(isMac ? [{ role: "appMenu" }] : []),
        { role: "fileMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });

    app.whenReady().then(async () => {
        tryApplyPendingOnStartup();
        loadCookiesFromSession();
        void applyCookiesToElectronSession();
        installMenu();

        let splash = null;
        try {
            if (fs.existsSync(splashHtmlPath())) {
                splash = createSplashWindow();
                await waitSplashDomReady(splash);
                await runColdStartSplash(splash);
            } else {
                void startCanvasAgent();
            }
        } catch (error) {
            appendMainLog(`splash failed: ${error && error.message ? error.message : String(error)}`);
            void startCanvasAgent();
        }

        createWindow();

        // Safety: never leave splash up forever if ready-to-show stalls.
        setTimeout(() => {
            if (splashWindow && !splashWindow.isDestroyed()) {
                appendMainLog("splash safety timeout; showing main window");
                closeSplashWindow();
                if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
            }
        }, 20000);
    });

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    app.on("window-all-closed", () => {
        if (!isMac) app.quit();
    });

    const quitAgent = () => {
        stopCanvasAgentChild();
    };
    app.on("will-quit", quitAgent);
    app.on("quit", quitAgent);

    process.on("uncaughtException", (error) => {
        appendMainLog(`uncaughtException: ${error && error.stack ? error.stack : String(error)}`);
    });
    process.on("unhandledRejection", (reason) => {
        appendMainLog(`unhandledRejection: ${reason && reason.stack ? reason.stack : String(reason)}`);
    });
}
