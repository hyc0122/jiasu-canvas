import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `${process.env.VITE_BASE || "/"}plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

function rewriteWuxinProxyCookies(value: string) {
    return value
        .replace(/;\s*Domain=[^;]*/gi, "")
        .replace(/;\s*Secure/gi, "")
        .replace(/;\s*SameSite=[^;]*/gi, "; SameSite=Lax")
        .replace(/Path=\/api\/user\/auth/i, "Path=/__wuxin/api/user/auth");
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
    server: {
        proxy: {
            "/__wuxin": {
                target: "https://www.wuxin-ai.xyz",
                changeOrigin: true,
                secure: true,
                rewrite: (path) => path.replace(/^\/__wuxin/, ""),
                configure: (proxy) => {
                    proxy.on("proxyReq", (proxyReq) => {
                        proxyReq.setHeader("origin", "https://www.wuxin-ai.xyz");
                        proxyReq.setHeader("referer", "https://www.wuxin-ai.xyz/");
                    });
                    proxy.on("proxyRes", (proxyRes) => {
                        const cookies = proxyRes.headers["set-cookie"];
                        if (!cookies) return;
                        const list = Array.isArray(cookies) ? cookies : [cookies];
                        proxyRes.headers["set-cookie"] = list.map(rewriteWuxinProxyCookies);
                    });
                },
            },
        },
    },
});
