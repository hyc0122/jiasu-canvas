#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const rootDir = path.resolve(desktopDir, "..");
const webDir = path.join(rootDir, "web");
const webDist = path.join(desktopDir, "web-dist");
const releaseDir = path.join(rootDir, "release");

const version = fs.readFileSync(path.join(rootDir, "VERSION"), "utf8").trim().replace(/^v/i, "") || "0.0.0";
const mode = (process.argv[2] || "all").toLowerCase();

function run(command, args, opts = {}) {
    const result = spawnSync(command, args, {
        cwd: opts.cwd || desktopDir,
        env: { ...process.env, ...(opts.env || {}) },
        stdio: "inherit",
        shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const error = new Error(`${command} ${args.join(" ")} failed (${result.status})`);
        error.status = result.status;
        throw error;
    }
}

function commandExists(command) {
    const finder = process.platform === "win32" ? "where" : "which";
    return spawnSync(finder, [command], { encoding: "utf8" }).status === 0;
}

function hasWine() {
    return commandExists("wine") || commandExists("wine64");
}

function syncPackageVersion() {
    const pkgPath = path.join(desktopDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg.version === version) return;
    pkg.version = version;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
    console.log(`[pack] desktop/package.json version -> ${version}`);
}

function buildWeb() {
    if (!fs.existsSync(path.join(webDir, "package.json"))) {
        throw new Error(`web package not found: ${webDir}`);
    }
    const env = { VITE_BASE: "./", VITE_ROUTER_MODE: "hash" };
    console.log(`[pack] building web with VITE_BASE=./ VITE_ROUTER_MODE=hash`);
    if (commandExists("bun")) {
        run("bun", ["run", "build"], { cwd: webDir, env });
    } else {
        run("npm", ["run", "build"], { cwd: webDir, env });
    }
    const built = path.join(webDir, "dist", "index.html");
    if (!fs.existsSync(built)) {
        throw new Error("web build did not produce dist/index.html");
    }
    fs.rmSync(webDist, { recursive: true, force: true });
    fs.cpSync(path.join(webDir, "dist"), webDist, { recursive: true });
    const html = fs.readFileSync(path.join(webDist, "index.html"), "utf8");
    if (html.includes('src="/assets/') || html.includes('href="/assets/')) {
        throw new Error("web-dist still uses absolute /assets/ URLs; VITE_BASE=./ did not apply");
    }
    console.log(`[pack] copied web/dist -> ${webDist}`);
}

function builderArgs(targets) {
    return ["exec", "--", "electron-builder", "--publish", "never", ...targets];
}

function packWithBuilder(targets) {
    run("npm", builderArgs(targets), {
        env: {
            CSC_IDENTITY_AUTO_DISCOVERY: "false",
            GH_TOKEN: "",
            GITHUB_TOKEN: "",
        },
    });
}

function listReleaseFiles() {
    if (!fs.existsSync(releaseDir)) return [];
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === "linux-unpacked" || entry.name === "win-unpacked" || entry.name === "mac") {
                    out.push(full);
                    continue;
                }
                walk(full);
            } else if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml") && !entry.name.endsWith(".blockmap")) {
                out.push(full);
            }
        }
    };
    walk(releaseDir);
    return out;
}

function classify(file) {
    const name = path.basename(file).toLowerCase();
    if (name.endsWith(".appimage") || name.endsWith(".deb") || name.endsWith("-setup.exe") || name.includes("setup")) {
        return "installer";
    }
    if (name.endsWith(".tar.gz") || name.includes("portable") || name.endsWith(".zip")) {
        return "portable";
    }
    if (name.endsWith(".exe")) return "windows-exe";
    return "other";
}

function packTargets() {
    const linux = ["--linux", "AppImage", "deb", "tar.gz"];
    const winInstaller = ["--win", "nsis", "portable"];
    const winZip = ["--win", "zip"];

    if (mode === "linux") {
        packWithBuilder(linux);
        return;
    }
    if (mode === "win") {
        if (process.env.FORCE_WIN_ZIP === "1" || (process.platform !== "win32" && !hasWine())) {
            console.warn("[pack] Building Windows zip (green pack)" + (process.env.FORCE_WIN_ZIP === "1" ? " (FORCE_WIN_ZIP)." : "; Wine not found."));
            packWithBuilder(winZip);
            return;
        }
        try {
            packWithBuilder(winInstaller);
        } catch (error) {
            console.warn(`[pack] Windows NSIS/portable failed: ${error.message}`);
            console.warn("[pack] falling back to Windows zip (green pack).");
            packWithBuilder(winZip);
        }
        return;
    }

    const wantWin = process.platform === "win32" || hasWine();
    try {
        packWithBuilder(wantWin ? [...linux, ...winInstaller] : [...linux, ...winZip]);
    } catch (error) {
        console.warn(`[pack] combined targets failed: ${error.message}`);
        console.warn("[pack] retrying Linux packages only, then Windows zip.");
        packWithBuilder(linux);
        try {
            packWithBuilder(winZip);
        } catch (winError) {
            console.warn(`[pack] Windows zip also failed: ${winError.message}`);
        }
    }
}


function stageAgentPack() {
    const src = path.join(rootDir, "canvas-agent");
    const dest = path.join(desktopDir, ".agent-pack");
    const httpEntry = path.join(src, "dist", "server", "http.js");
    if (!fs.existsSync(httpEntry)) {
        throw new Error(`canvas-agent build missing: ${httpEntry}`);
    }
    if (!fs.existsSync(path.join(src, "node_modules", "express"))) {
        throw new Error("canvas-agent/node_modules/express missing; run npm install in canvas-agent first");
    }

    console.log(`[pack] staging canvas-agent runtime -> ${dest}`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(path.join(src, "dist"), path.join(dest, "dist"), { recursive: true });
    fs.copyFileSync(path.join(src, "agent-instructions.md"), path.join(dest, "agent-instructions.md"));
    fs.copyFileSync(path.join(src, "package.json"), path.join(dest, "package.json"));

    const skipTop = new Set(["typescript", "tsx", "esbuild"]);
    const skipScope = new Set(["@openai", "@types", "@esbuild"]);
    const nmSrc = path.join(src, "node_modules");
    const nmDest = path.join(dest, "node_modules");
    fs.cpSync(nmSrc, nmDest, {
        recursive: true,
        filter: (from) => {
            const rel = path.relative(nmSrc, from);
            if (!rel || rel === ".") return true;
            const parts = rel.split(path.sep);
            if (skipTop.has(parts[0])) return false;
            if (skipScope.has(parts[0])) return false;
            if (parts[0] === "@openai" && parts[1] === "codex") return false;
            return true;
        },
    });

    const express = path.join(dest, "node_modules", "express");
    if (!fs.existsSync(express)) {
        throw new Error("staged .agent-pack is missing node_modules/express");
    }
    console.log(`[pack] staged agent pack includes express at ${express}`);
}

function verifyPackedAgent() {
    const candidates = [
        path.join(releaseDir, "win-unpacked", "resources", "canvas-agent", "node_modules", "express"),
        path.join(releaseDir, "linux-unpacked", "resources", "canvas-agent", "node_modules", "express"),
    ];
    const found = candidates.filter((item) => fs.existsSync(item));
    if (!found.length) {
        throw new Error("[pack] packed canvas-agent is missing node_modules/express; extraResources/.agent-pack staging failed");
    }
    for (const item of found) {
        console.log(`[pack] verified ${item}`);
    }
}

function main() {
    syncPackageVersion();
    if (mode !== "pack-only") buildWeb();
    if (mode === "web") return;

    stageAgentPack();
    packTargets();
    verifyPackedAgent();

    const files = listReleaseFiles();
    console.log("\n[pack] artifacts:");
    for (const file of files) {
        const stat = fs.statSync(file);
        const size = stat.isDirectory() ? "dir" : `${(stat.size / (1024 * 1024)).toFixed(1)} MB`;
        console.log(`  ${classify(file).padEnd(12)} ${file} (${size})`);
    }
    const kinds = new Set(files.map(classify));
    const hasInstaller = [...kinds].some((k) => k === "installer");
    const hasPortable = [...kinds].some((k) => k === "portable" || k === "windows-exe");
    if (!hasInstaller || !hasPortable) {
        console.warn("[pack] expected at least one installer and one portable artifact.");
    }
}

main();
