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

const FRIENDLY_BUSY_ZH =
    "更新文件被占用（常见于杀毒扫描）。请完全退出佳速画布后删除文件夹 %APPDATA%\\佳速画布\\pending-update，再重试「检查更新」；或直接安装最新绿色版 zip。";

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

function sleep(ms) {
    const AtomicsWait = typeof Atomics !== "undefined" && Atomics.wait;
    if (AtomicsWait && typeof SharedArrayBuffer !== "undefined") {
        try {
            const sab = new SharedArrayBuffer(4);
            const ia = new Int32Array(sab);
            Atomics.wait(ia, 0, 0, ms);
            return;
        } catch {
            // fall through
        }
    }
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // busy wait fallback for sync contexts
    }
}

function isBusyError(err) {
    if (!err) return false;
    const code = err.code || "";
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return true;
    const msg = String(err.message || err);
    return /\bEBUSY\b|\bEPERM\b|\bEACCES\b|resource busy|locked/i.test(msg);
}

function friendlyError(err) {
    if (isBusyError(err)) return FRIENDLY_BUSY_ZH;
    return err && err.message ? err.message : String(err);
}

function pendingDir() {
    return path.join(app.getPath("userData"), "pending-update");
}

function trashDir() {
    return path.join(app.getPath("userData"), "trash");
}

function activeStageMarker() {
    return path.join(pendingDir(), "ACTIVE");
}

function renameAside(target) {
    const base = path.basename(target);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const trashName = `${base}.trash-${stamp}`;
    const parent = path.dirname(target);
    let dest = path.join(parent, trashName);
    try {
        fs.renameSync(target, dest);
        return dest;
    } catch {
        try {
            fs.mkdirSync(trashDir(), { recursive: true });
            dest = path.join(trashDir(), trashName);
            fs.renameSync(target, dest);
            return dest;
        } catch {
            return null;
        }
    }
}

/**
 * Remove a file/dir with retries. On final failure for a **file**, rename-aside
 * and continue (never throw EBUSY for leftover trash).
 * @param {string} target
 * @param {{ retries?: number }} [opts]
 */
function rmWithRetry(target, opts = {}) {
    const retries = opts.retries == null ? 8 : opts.retries;
    if (!fs.existsSync(target)) return;
    let lastErr = null;
    for (let i = 0; i <= retries; i += 1) {
        try {
            fs.rmSync(target, { recursive: true, force: true });
            return;
        } catch (err) {
            lastErr = err;
            if (!isBusyError(err) || i === retries) break;
            sleep(250 + i * 150);
        }
    }
    if (!lastErr) return;
    let isFile = false;
    try {
        isFile = fs.statSync(target).isFile();
    } catch {
        return;
    }
    if (isFile && isBusyError(lastErr)) {
        if (renameAside(target)) return;
        // leftover trash — do not throw EBUSY
        return;
    }
    if (isBusyError(lastErr)) {
        // directory still locked: try rename-aside the whole dir
        if (renameAside(target)) return;
        return;
    }
    throw lastErr;
}

/**
 * Clear pending-update contents with retries. Locked app.asar is renamed aside;
 * parent dir is kept / recreated fresh.
 */
function clearPendingDir() {
    const dir = pendingDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        return;
    }
    let entries = [];
    try {
        entries = fs.readdirSync(dir);
    } catch (err) {
        if (isBusyError(err)) {
            renameAside(dir);
            fs.mkdirSync(dir, { recursive: true });
            return;
        }
        throw err;
    }
    for (const name of entries) {
        const full = path.join(dir, name);
        try {
            rmWithRetry(full, { retries: 8 });
        } catch (err) {
            if (isBusyError(err)) {
                renameAside(full);
            } else {
                throw err;
            }
        }
    }
    // If a locked app.asar (or anything) still remains, rename-aside and ensure dir exists
    try {
        const left = fs.readdirSync(dir);
        for (const name of left) {
            renameAside(path.join(dir, name));
        }
    } catch {
        // ignore
    }
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch {
        renameAside(dir);
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Prefer unique stage subdir under pending-update.
 * @param {string} version
 */
function createStageDir(version) {
    const parent = pendingDir();
    fs.mkdirSync(parent, { recursive: true });
    const safeVer = String(version || "unknown").replace(/[^\w.-]+/g, "_");
    const stage = path.join(parent, `stage-${safeVer}-${Date.now()}`);
    fs.mkdirSync(stage, { recursive: true });
    try {
        fs.writeFileSync(activeStageMarker(), stage, "utf8");
    } catch {
        // ignore
    }
    return stage;
}

/**
 * Resolve active stage: ACTIVE file, else newest stage-* with manifest.json,
 * else pendingDir itself (legacy flat layout).
 */
function resolveActiveStageDir() {
    const parent = pendingDir();
    const marker = activeStageMarker();
    if (fs.existsSync(marker)) {
        try {
            const p = fs.readFileSync(marker, "utf8").trim();
            if (p && fs.existsSync(path.join(p, "manifest.json"))) return p;
        } catch {
            // fall through
        }
    }
    if (!fs.existsSync(parent)) return parent;
    let best = null;
    let bestMtime = -1;
    try {
        for (const name of fs.readdirSync(parent)) {
            if (!name.startsWith("stage-")) continue;
            const full = path.join(parent, name);
            const man = path.join(full, "manifest.json");
            if (!fs.existsSync(man)) continue;
            let mtime = 0;
            try {
                mtime = fs.statSync(man).mtimeMs;
            } catch {
                mtime = 0;
            }
            if (mtime >= bestMtime) {
                bestMtime = mtime;
                best = full;
            }
        }
    } catch {
        // ignore
    }
    if (best) return best;
    if (fs.existsSync(path.join(parent, "manifest.json"))) return parent;
    return parent;
}

function localAsarPath() {
    return path.join(process.resourcesPath, "app.asar");
}

function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(filePath, "r");
    try {
        const buf = Buffer.alloc(1024 * 1024);
        let bytesRead;
        while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
            hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(fd);
    }
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

    try {
        if (fs.existsSync(destPath)) {
            try {
                fs.unlinkSync(destPath);
            } catch (err) {
                if (isBusyError(err)) {
                    renameAside(destPath);
                } else {
                    throw err;
                }
            }
        }
        fs.renameSync(tmp, destPath);
    } catch (err) {
        if (isBusyError(err)) {
            const alt = `${destPath}.new`;
            try {
                if (fs.existsSync(alt)) renameAside(alt);
            } catch {
                // ignore
            }
            try {
                fs.renameSync(tmp, alt);
            } catch {
                fs.copyFileSync(tmp, alt);
                try {
                    fs.unlinkSync(tmp);
                } catch {
                    // ignore
                }
            }
            if (fs.existsSync(destPath)) renameAside(destPath);
            try {
                fs.renameSync(alt, destPath);
            } catch (err2) {
                if (isBusyError(err2)) {
                    // leave as dest.new — caller can still use alt if needed
                    fs.copyFileSync(alt, destPath);
                } else {
                    throw err2;
                }
            }
        } else {
            throw err;
        }
    }
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
        const message = friendlyError(error);
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

    try {
        clearPendingDir();
    } catch (err) {
        if (isBusyError(err)) {
            throw new Error(FRIENDLY_BUSY_ZH);
        }
        throw err;
    }

    const version = String(manifest.version || "").replace(/^v/i, "") || "unknown";
    const dir = createStageDir(version);

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
        stageDir: dir,
        stagedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(pendingManifest, null, 2));
    try {
        fs.writeFileSync(activeStageMarker(), dir, "utf8");
    } catch {
        // ignore
    }
    emitProgress(100, "staged");
    updateState = {
        ...updateState,
        status: "staged",
        progress: 100,
        remoteVersion: version,
        notes: manifest.notes || "",
        manifest,
        updateAvailable: true,
    };
    return getStatus();
}

function writeApplyScript(resourcesPath, execPath, dir, pid) {
    const isWin = process.platform === "win32";
    if (isWin) {
        const bat = path.join(dir, "apply-update.bat");
        const pidStr = String(pid || process.pid);
        const lines = [
            "@echo off",
            "setlocal EnableExtensions",
            `set "SRC=${dir}"`,
            `set "RES=${resourcesPath}"`,
            `set "EXE=${execPath}"`,
            `set "PID=${pidStr}"`,
            "set /a WAITED=0",
            ":wait_pid",
            'if "%PID%"=="" goto do_copy',
            'tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul',
            "if errorlevel 1 goto do_copy",
            "timeout /t 1 /nobreak >nul",
            "set /a WAITED+=1",
            "if %WAITED% GEQ 60 goto do_copy",
            "goto wait_pid",
            ":do_copy",
            "set /a TRY=0",
            ":copy_loop",
            'if not exist "%SRC%\\app.asar" goto after_copy',
            'copy /Y "%SRC%\\app.asar" "%RES%\\app.asar" >nul 2>&1',
            "if not errorlevel 1 goto after_copy",
            "set /a TRY+=1",
            "if %TRY% GEQ 20 (",
            "  echo copy failed after retries",
            "  goto cleanup",
            ")",
            "timeout /t 1 /nobreak >nul",
            "goto copy_loop",
            ":after_copy",
            'if exist "%SRC%\\app.asar" (',
            '  rem verify copy roughly by size presence',
            '  if not exist "%RES%\\app.asar" goto cleanup',
            ")",
            'start "" "%EXE%"',
            ":cleanup",
            "set /a DTRY=0",
            ":del_loop",
            'rd /s /q "%SRC%" >nul 2>&1',
            'if not exist "%SRC%" goto done',
            "set /a DTRY+=1",
            "if %DTRY% GEQ 10 goto done",
            "timeout /t 1 /nobreak >nul",
            "goto del_loop",
            ":done",
            "endlocal",
        ];
        fs.writeFileSync(bat, `${lines.join("\r\n")}\r\n`, "utf8");
        return bat;
    }

    const sh = path.join(dir, "apply-update.sh");
    const pidStr = String(pid || process.pid);
    const script = `#!/bin/bash
set +e
SRC=${JSON.stringify(dir)}
RES=${JSON.stringify(resourcesPath)}
EXE=${JSON.stringify(execPath)}
PID=${JSON.stringify(pidStr)}
WAITED=0
while [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; do
  sleep 1
  WAITED=$((WAITED+1))
  if [ "$WAITED" -ge 60 ]; then break; fi
done
TRY=0
if [ -f "$SRC/app.asar" ]; then
  while [ "$TRY" -lt 20 ]; do
    if cp -f "$SRC/app.asar" "$RES/app.asar"; then break; fi
    TRY=$((TRY+1))
    sleep 1
  done
fi
if [ -f "$RES/app.asar" ] || [ ! -f "$SRC/app.asar" ]; then
  nohup "$EXE" >/dev/null 2>&1 &
fi
DTRY=0
while [ "$DTRY" -lt 10 ]; do
  rm -rf "$SRC" && break
  DTRY=$((DTRY+1))
  sleep 1
done
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
    const dir = resolveActiveStageDir();
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) throw new Error("no pending update to apply");
    const pending = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const resourcesPath = pending.resourcesPath || process.resourcesPath;
    const execPath = pending.execPath || process.execPath;
    const pid = pending.pid || process.pid;
    const script = writeApplyScript(resourcesPath, execPath, dir, pid);

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
        const message = friendlyError(error);
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
    const dir = resolveActiveStageDir();
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
        try {
            rmWithRetry(dir, { retries: 8 });
        } catch {
            // ignore leftover
        }
        try {
            const marker = activeStageMarker();
            if (fs.existsSync(marker)) rmWithRetry(marker, { retries: 3 });
        } catch {
            // ignore
        }
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
    sleep,
    isBusyError,
    rmWithRetry,
    clearPendingDir,
};
