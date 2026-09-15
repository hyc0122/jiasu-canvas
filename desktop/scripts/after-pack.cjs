"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * electron-builder extraResources can still drop node_modules because the repo
 * .gitignore matches `node_modules/`. Copy the staged runtime after pack so
 * installers (NSIS / AppImage / deb / tar.gz) include express/zod.
 */
module.exports = async function afterPack(context) {
    const staged = path.join(__dirname, "..", ".agent-pack");
    const dest = path.join(context.appOutDir, "resources", "canvas-agent");
    const stagedExpress = path.join(staged, "node_modules", "express");
    if (!fs.existsSync(stagedExpress)) {
        throw new Error(`[pack] staged agent pack missing express: ${stagedExpress}`);
    }
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(staged, dest, { recursive: true });
    const packedExpress = path.join(dest, "node_modules", "express");
    if (!fs.existsSync(packedExpress)) {
        throw new Error(`[pack] afterPack failed to place express at ${packedExpress}`);
    }
    console.log(`[pack] afterPack ensured canvas-agent runtime at ${dest}`);
};
module.exports.default = module.exports;
