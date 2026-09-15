"use strict";

const { app, ipcMain, net } = require("electron");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** Public R2 ai-updates base (r2.dev). Override with UPDATE_MANIFEST_URL or UPDATE_BASE_URL. */
const DEFAULT_UPDATE_BASE = "https://pub-9421f55db6c34366916271bbeaaeb1ba.r2.dev";
const UPDATE_MANIFEST_URL =
    process.env.UPDATE_MANIFEST_URL ||
    `${(process.env.UPDATE_BASE_URL || DEFAULT_UPDATE_BASE).replace(/\/$/, "")}/jiasu-canvas/win-x64/latest.json`;

/**
 * @typedef {{ path: string; url: string; sha256: string; size?: number }} UpdateFile
 * @typedef {{
 *   version: string;
 *   minAppVersion?: string;
 *   channel?: string;
 *   publishedAt?: string;
 *   notes?: string;
 *   files: UpdateFile[];
 *   fullPackageUrl?: string;
 * }} UpdateManifest
 */

/** @type {{ status: string; localVersion: string; remoteVersion?: string; notes?: string; progress?: number; error?: string; updateAvailable?: boolean; manifest?: UpdateManifest | null }} */
let updateState = {
    status: "idle",
    localVersion: "",
    updateAvailable: false,
    manifest: null,
};

/** @type {((payload: { percent: number; status: string }) => void) | null} */
let progressSink = null;

function compareSemver(a, b) {
    const parse = (v) => {
        const m = String(v || "")
            .trim()
            .replace(/^v/i, "")
            .match(/^(\d+)\.(\d+)\.(\d+)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const left = parse(a);
    const right = parse(b);
    if (!left || !right) return 0;
    for (let i = 0; i < 3; i += 1) {
        if (left[i] > right[i]) return 1;
        if (left[i] < right[i]) return -1;
    }
    return 0;
}

function pendingDir() {
    return path.join(app.getPath("userData"), "pending-update");
}

function localAsarPath() {
    return path.join(process.resourcesPath, "app.asar");
}

function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}

function emitProgress(percent, status) {
    updateState = { ...updateState, progress: percent, status };
    if (progressSink) progressSink({ percent, status });
}

async function fetchJson(url) {
    const response = await net.fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
    return response.json();
}

async function downloadToFile(url, destPath, onChunk) {
    const response = await net.fetch(url, { method: "GET" });
    if (!response.ok) throw new Error(`download HTTP ${response.status} for ${url}`);
    const total = Number(response.headers.get("content-length") || 0);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmp = `${destPath}.part`;
    const body = response.body;
    if (!body) throw new Error("empty response body");

    // Prefer streaming when available; fall back to arrayBuffer.
    if (typeof body.getReader === "function") {
        const reader = body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
            received += value.byteLength;
            if (onChunk) onChunk(received, total);
        }
        fs.writeFileSync(tmp, Buffer.concat(chunks));
    } else {
        const buf = Buffer.from(await response.arrayBuffer());
        if (onChunk) onChunk(buf.length, total || buf.length);
        fs.writeFileSync(tmp, buf);
    }
    fs.renameSync(tmp, destPath);
    return destPath;
}

function getStatus() {
    return {
        ...updateState,
        localVersion: app.getVersion(),
        packaged: app.isPackaged,
        manifestUrl: UPDATE_MANIFEST_URL,
    };
}

async function checkForUpdate() {
    if (!app.isPackaged) {
        updateState = {
            status: "skipped",
            localVersion: app.getVersion(),
            updateAvailable: false,
            manifest: null,
            error: "updates only run in packaged builds",
        };
        return getStatus();
    }

    updateState = { ...updateState, status: "checking", error: undefined, localVersion: app.getVersion() };
    emitProgress(0, "checking");
    try {
        /** @type {UpdateManifest} */
        const manifest = await fetchJson(UPDATE_MANIFEST_URL);
        const local = app.getVersion();
        const remote = String(manifest.version || "").replace(/^v/i, "");
        const available = compareSemver(remote, local) > 0;
        updateState = {
            status: available ? "available" : "up-to-date",
            localVersion: local,
            remoteVersion: remote,
            notes: manifest.notes || "",
            updateAvailable: available,
            manifest: available ? manifest : null,
            progress: 0,
        };
        emitProgress(0, updateState.status);
        return getStatus();
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        updateState = {
            status: "error",
            localVersion: app.getVersion(),
            updateAvailable: false,
            manifest: null,
            error: message,
        };
        emitProgress(0, "error");
        return getStatus();
    }
}

/**
 * @param {UpdateManifest} manifest
 */
async function downloadAndStageUpdate(manifest) {
    if (!app.isPackaged) {
        throw new Error("updates only run in packaged builds");
    }
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (!files.length) throw new Error("manifest has no files");

    const dir = pendingDir();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const staged = [];
    let index = 0;
    for (const file of files) {
        index += 1;
        const rel = String(file.path || "app.asar").replace(/^[/\\]+/, "");
        const localResource = path.join(process.resourcesPath, rel);
        let localHash = "";
        try {
            if (fs.existsSync(localResource)) localHash = sha256File(localResource);
        } catch {
            localHash = "";
        }
        const expected = String(file.sha256 || "").toLowerCase();
        if (expected && localHash && localHash === expected) {
            emitProgress(Math.round((index / files.length) * 100), `skip:${rel}`);
            continue;
        }

        const dest = path.join(dir, rel);
        emitProgress(Math.round(((index - 1) / files.length) * 100), `download:${rel}`);
        await downloadToFile(file.url, dest, (received, total) => {
            const filePct = total > 0 ? received / total : 0;
            const overall = ((index - 1 + filePct) / files.length) * 100;
            emitProgress(Math.min(99, Math.round(overall)), `download:${rel}`);
        });
        const actual = sha256File(dest).toLowerCase();
        if (expected && actual !== expected) {
            throw new Error(`sha256 mismatch for ${rel}: expected ${expected}, got ${actual}`);
        }
        staged.push({ path: rel, sha256: actual, size: fs.statSync(dest).size });
    }

    const pendingManifest = {
        ...manifest,
        staged,
        resourcesPath: process.resourcesPath,
        execPath: process.execPath,
        pid: process.pid,
        stagedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(pendingManifest, null, 2));
    emitProgress(100, "staged");
    updateState = {
        ...updateState,
        status: "staged",
        progress: 100,
        remoteVersion: String(manifest.version || "").replace(/^v/i, ""),
        notes: manifest.notes || "",
        manifest,
        updateAvailable: true,
    };
    return getStatus();
}

function writeApplyScript(resourcesPath, execPath, dir) {
    const isWin = process.platform === "win32";
    if (isWin) {
        const bat = path.join(dir, "apply-update.bat");
        const lines = [
            "@echo off",
            "setlocal",
            "timeout /t 2 /nobreak >nul",
            `set "SRC=${dir}"`,
            `set "RES=${resourcesPath}"`,
            `set "EXE=${execPath}"`,
            'if exist "%SRC%\\app.asar" copy /Y "%SRC%\\app.asar" "%RES%\\app.asar" >nul',
            'if exist "%SRC%\\manifest.json" (',
            "  rem optional extra files next to app.asar",
            ")",
            'start "" "%EXE%"',
            'rd /s /q "%SRC%" >nul 2>&1',
            "endlocal",
        ];
        fs.writeFileSync(bat, `${lines.join("\r\n")}\r\n`, "utf8");
        return bat;
    }

    const sh = path.join(dir, "apply-update.sh");
    const script = `#!/bin/bash
set -e
sleep 2
SRC=${JSON.stringify(dir)}
RES=${JSON.stringify(resourcesPath)}
EXE=${JSON.stringify(execPath)}
if [ -f "$SRC/app.asar" ]; then
  cp -f "$SRC/app.asar" "$RES/app.asar"
fi
nohup "$EXE" >/dev/null 2>&1 &
rm -rf "$SRC"
`;
    fs.writeFileSync(sh, script, { mode: 0o755 });
    try {
        fs.chmodSync(sh, 0o755);
    } catch {
        // ignore
    }
    return sh;
}

function spawnDetachedApplyer() {
    const dir = pendingDir();
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) throw new Error("no pending update to apply");
    const pending = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const resourcesPath = pending.resourcesPath || process.resourcesPath;
    const execPath = pending.execPath || process.execPath;
    const script = writeApplyScript(resourcesPath, execPath, dir);

    if (process.platform === "win32") {
        spawn("cmd.exe", ["/c", script], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        }).unref();
    } else {
        spawn("bash", [script], {
            detached: true,
            stdio: "ignore",
        }).unref();
    }
}

async function downloadAndInstallUpdate() {
    if (!app.isPackaged) {
        return { ok: false, error: "updates only run in packaged builds", ...getStatus() };
    }
    let manifest = updateState.manifest;
    if (!manifest) {
        const status = await checkForUpdate();
        if (!status.updateAvailable || !status.manifest) {
            return { ok: false, error: status.error || "no update available", ...status };
        }
        manifest = status.manifest;
    }
    try {
        emitProgress(1, "downloading");
        await downloadAndStageUpdate(manifest);
        emitProgress(100, "restarting");
        spawnDetachedApplyer();
        setTimeout(() => {
            app.quit();
        }, 300);
        return { ok: true, ...getStatus() };
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        updateState = { ...updateState, status: "error", error: message };
        emitProgress(updateState.progress || 0, "error");
        return { ok: false, error: message, ...getStatus() };
    }
}

/**
 * Apply a previously staged update on cold start if the applyer did not run
 * (best-effort). Prefer the detached applyer path for Windows asar locks.
 */
function tryApplyPendingOnStartup() {
    if (!app.isPackaged) return false;
    const dir = pendingDir();
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) return false;
    try {
        const pending = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const staged = Array.isArray(pending.staged) ? pending.staged : [];
        for (const file of staged) {
            const src = path.join(dir, file.path);
            const dest = path.join(process.resourcesPath, file.path);
            if (!fs.existsSync(src)) continue;
            try {
                fs.copyFileSync(src, dest);
            } catch {
                // asar may still be locked; leave pending for applyer
                return false;
            }
        }
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
    } catch {
        return false;
    }
}

function registerUpdateIpc(getMainWindow) {
    ipcMain.handle("update:check", async () => checkForUpdate());
    ipcMain.handle("update:downloadAndInstall", async () => downloadAndInstallUpdate());
    ipcMain.handle("update:getStatus", async () => getStatus());
    ipcMain.handle("app:getVersion", async () => app.getVersion());

    progressSink = (payload) => {
        const win = typeof getMainWindow === "function" ? getMainWindow() : null;
        if (win && !win.isDestroyed()) {
            win.webContents.send("update:progress", payload);
        }
    };
}

module.exports = {
    UPDATE_MANIFEST_URL,
    DEFAULT_UPDATE_BASE,
    checkForUpdate,
    downloadAndInstallUpdate,
    getStatus,
    registerUpdateIpc,
    tryApplyPendingOnStartup,
    compareSemver,
};
