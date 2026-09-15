#!/usr/bin/env node
"use strict";

/**
 * Publish a hot-update package to the public ai-updates R2 bucket.
 *
 * Usage:
 *   node desktop/scripts/publish-update.cjs [win-unpacked-dir]
 *
 * Env:
 *   UPDATE_BASE_URL  — public base (default pub-*.r2.dev for ai-updates)
 *   FULL_PACKAGE_URL — optional override for fullPackageUrl in latest.json
 *   UPDATE_NOTES     — release notes
 *   SKIP_UPLOAD=1    — only write local latest.json + print commands
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const rootDir = path.resolve(desktopDir, "..");
const releaseDir = path.join(rootDir, "release");
const DEFAULT_UPDATE_BASE = "https://pub-9421f55db6c34366916271bbeaaeb1ba.r2.dev";
const UPDATE_BASE = (process.env.UPDATE_BASE_URL || DEFAULT_UPDATE_BASE).replace(/\/$/, "");
const PLATFORM = "win-x64";

function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}

function run(command, args, opts = {}) {
    console.log(`[publish-update] $ ${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, {
        cwd: opts.cwd || rootDir,
        env: process.env,
        stdio: "inherit",
        shell: process.platform === "win32",
    });
    if (result.status !== 0) {
        throw new Error(`${command} failed (${result.status})`);
    }
}

function resolveUnpacked(input) {
    if (input) {
        const abs = path.resolve(input);
        if (!fs.existsSync(abs)) throw new Error(`path not found: ${abs}`);
        return abs;
    }
    const candidates = [
        path.join(releaseDir, "win-unpacked"),
        path.join(releaseDir, "win-unpacked", "resources"),
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, "resources", "app.asar"))) return c;
        if (fs.existsSync(path.join(c, "app.asar"))) return path.dirname(c);
    }
    if (fs.existsSync(path.join(releaseDir, "win-unpacked", "resources", "app.asar"))) {
        return path.join(releaseDir, "win-unpacked");
    }
    throw new Error("win-unpacked not found; pass path as argv[2]");
}

function readVersion(unpacked) {
    const pkg = path.join(unpacked, "resources", "app.asar");
    // Prefer VERSION / desktop package.json
    const versionFile = path.join(rootDir, "VERSION");
    if (fs.existsSync(versionFile)) {
        return fs.readFileSync(versionFile, "utf8").trim().replace(/^v/i, "");
    }
    const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
    return String(desktopPkg.version || "0.0.0");
}

function main() {
    const unpacked = resolveUnpacked(process.argv[2]);
    const asar = path.join(unpacked, "resources", "app.asar");
    if (!fs.existsSync(asar)) throw new Error(`app.asar missing: ${asar}`);

    const version = readVersion(unpacked);
    const hash = sha256File(asar);
    const size = fs.statSync(asar).size;
    const asarKey = `jiasu-canvas/${PLATFORM}/${version}/app.asar`;
    const asarUrl = `${UPDATE_BASE}/${asarKey}`;
    const fullPackageUrl =
        process.env.FULL_PACKAGE_URL ||
        `https://cdn.jiasuapi.com/d/jiasu-canvas-${version}-win-x64.zip`;
    const notes = process.env.UPDATE_NOTES || `佳速画布 ${version}`;

    const manifest = {
        version,
        minAppVersion: process.env.MIN_APP_VERSION || "0.19.0",
        channel: "stable",
        publishedAt: new Date().toISOString(),
        notes,
        files: [
            {
                path: "app.asar",
                url: asarUrl,
                sha256: hash,
                size,
            },
        ],
        fullPackageUrl,
    };

    const outDir = path.join(releaseDir, "update-staging", version);
    fs.mkdirSync(outDir, { recursive: true });
    const manifestPath = path.join(outDir, "latest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.copyFileSync(asar, path.join(outDir, "app.asar"));
    console.log(`[publish-update] staged ${outDir}`);
    console.log(`[publish-update] sha256=${hash} size=${size}`);
    console.log(`[publish-update] manifest -> ${manifestPath}`);

    if (process.env.SKIP_UPLOAD === "1") {
        console.log("[publish-update] SKIP_UPLOAD=1; not uploading");
        console.log(JSON.stringify(manifest, null, 2));
        return;
    }

    run("npx", [
        "wrangler",
        "r2",
        "object",
        "put",
        `ai-updates/${asarKey}`,
        "--file",
        asar,
        "--content-type",
        "application/octet-stream",
        "--cache-control",
        "public, max-age=31536000, immutable",
        "--remote",
    ]);

    run("npx", [
        "wrangler",
        "r2",
        "object",
        "put",
        `ai-updates/jiasu-canvas/${PLATFORM}/latest.json`,
        "--file",
        manifestPath,
        "--content-type",
        "application/json",
        "--cache-control",
        "public, max-age=60",
        "--remote",
    ]);

    console.log("\n[publish-update] done");
    console.log(`  manifest: ${UPDATE_BASE}/jiasu-canvas/${PLATFORM}/latest.json`);
    console.log(`  asar:     ${asarUrl}`);
    console.log(`  full zip: ${fullPackageUrl}`);
}

main();
