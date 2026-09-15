/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_RELEASES__: import("@/lib/release").ReleaseInfo[];

interface ImportMetaEnv {
    // Comma-separated local development plugin URLs, refetched on every startup without caching or persistence.
    readonly VITE_DEV_PLUGINS?: string;
    // Electron desktop builds set this to "hash" so file:// navigation works. Web/Docker leave it unset.
    readonly VITE_ROUTER_MODE?: string;
    readonly VITE_SHOW_INVITE_CODE?: string;
    // Optional build-time analytics configuration, with one independent variable per provider.
    // GA4 measurement ID (G-XXXX)
    readonly VITE_ANALYTICS_GA4_ID?: string;
    // Baidu Analytics site ID
    readonly VITE_ANALYTICS_BAIDU_ID?: string;
}

type CanvasAgentDesktopInfo = { url: string; token: string; started: boolean; error?: string };
type CanvasAgentAiConfigPayload = {
    baseUrl?: string;
    apiKey?: string;
    textModel?: string;
    textModels?: string[];
    systemPrompt?: string;
};

type DesktopSessionFile = {
    username?: string;
    password?: string;
    user?: unknown;
    accessToken?: string;
    accessExpiresAt?: number;
    cookies?: Record<string, { value: string; path?: string }>;
};

declare global {
    interface Window {
        interfaceCanvasDesktop?: {
            isElectron?: boolean;
            wuxinAuth?: (spec: {
                method?: string;
                path: string;
                params?: Record<string, string>;
                body?: Record<string, unknown>;
                headers?: Record<string, string>;
            }) => Promise<{ status: number; data: { success?: boolean; message?: string; data?: unknown } }>;
            getCanvasAgentInfo?: () => Promise<CanvasAgentDesktopInfo>;
            ensureCanvasAgentStarted?: () => Promise<CanvasAgentDesktopInfo>;
            setCanvasAgentAiConfig?: (ai: CanvasAgentAiConfigPayload) => Promise<{ ok?: boolean }>;
            loadSession?: () => Promise<DesktopSessionFile | null>;
            saveSession?: (session: DesktopSessionFile) => Promise<{ ok?: boolean }>;
            clearSession?: () => Promise<{ ok?: boolean }>;
            getAppVersion?: () => Promise<string>;
            checkForUpdate?: () => Promise<{
                status: string;
                localVersion: string;
                remoteVersion?: string;
                notes?: string;
                progress?: number;
                error?: string;
                updateAvailable?: boolean;
                packaged?: boolean;
                manifestUrl?: string;
            }>;
            downloadAndInstallUpdate?: () => Promise<{ ok?: boolean; error?: string; status?: string; progress?: number }>;
            getUpdateStatus?: () => Promise<Record<string, unknown>>;
            onUpdateProgress?: (handler: (payload: { percent: number; status: string }) => void) => () => void;
        };
    }
}

export {};
