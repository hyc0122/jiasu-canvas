import { create } from "zustand";
import { persist } from "zustand/middleware";

import { fetchWuxinSelf, loginWuxinUser, loginWuxinUser2fa, refreshWuxinSession, registerWuxinUser, type WuxinSession, type WuxinUser } from "@/services/api/auth";

export const USER_STORE_KEY = "infinite-canvas:user_store";

export type LocalUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    group?: string;
    quota?: number;
    usedQuota?: number;
    role?: number;
};

export type AuthChallenge = { ok: true } | { ok: false; flowToken: string };

export type RegisterPayload = {
    username: string;
    password: string;
    email: string;
    verification_code: string;
    aff_code?: string;
};

type UserStore = {
    user: LocalUser | null;
    accessToken: string;
    accessExpiresAt: number;
    lastUsername: string;
    lastPassword: string;
    hydrated: boolean;
    sessionChecked: boolean;
    login: (username: string, password: string) => Promise<AuthChallenge>;
    register: (payload: RegisterPayload) => Promise<void>;
    complete2fa: (flowToken: string, code: string) => Promise<void>;
    bootstrap: () => Promise<void>;
    refresh: () => Promise<boolean>;
    logout: () => void;
    clearSession: () => void;
};

let bootstrapPromise: Promise<void> | null = null;
let refreshTimer: number | null = null;
let sessionFileRestoreAttempted = false;

export function mapWuxinUser(user: WuxinUser): LocalUser {
    const username = user.username || "";
    return {
        id: String(user.id),
        username,
        displayName: user.display_name || username,
        avatarUrl: "",
        group: user.group,
        quota: user.quota,
        usedQuota: user.used_quota,
        role: user.role,
    };
}

function isTokenFresh(accessToken: string, accessExpiresAt: number) {
    if (!accessToken) return false;
    if (!accessExpiresAt) return true;
    const expiresAtMs = accessExpiresAt > 1e12 ? accessExpiresAt : accessExpiresAt * 1000;
    return expiresAtMs > Date.now() + 30_000;
}

function stopRefreshTimer() {
    if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
        refreshTimer = null;
    }
}

function scheduleRefresh(accessExpiresAt: number) {
    stopRefreshTimer();
    if (!accessExpiresAt) return;
    const expiresAtMs = accessExpiresAt > 1e12 ? accessExpiresAt : accessExpiresAt * 1000;
    const delay = Math.max(5_000, expiresAtMs - Date.now() - 60_000);
    refreshTimer = window.setTimeout(() => {
        void useUserStore.getState().refresh();
    }, delay);
}

function desktopBridge() {
    if (typeof window === "undefined") return undefined;
    return window.interfaceCanvasDesktop;
}

function asLocalUser(value: unknown): LocalUser | null {
    if (!value || typeof value !== "object") return null;
    const user = value as LocalUser & WuxinUser & { display_name?: string };
    if (user.id === undefined || user.id === null || user.id === "") return null;
    if ("displayName" in user) {
        return {
            id: String(user.id),
            username: user.username || "",
            displayName: user.displayName || user.username || "",
            avatarUrl: user.avatarUrl || "",
            group: user.group,
            quota: user.quota,
            usedQuota: user.usedQuota,
            role: user.role,
        };
    }
    return mapWuxinUser(user);
}

async function persistDesktopSession() {
    const desktop = desktopBridge();
    if (!desktop?.saveSession) return;
    const { user, accessToken, accessExpiresAt, lastUsername, lastPassword } = useUserStore.getState();
    try {
        await desktop.saveSession({
            username: user?.username || lastUsername || "",
            password: lastPassword || "",
            user,
            accessToken,
            accessExpiresAt,
        });
    } catch {
        // session.json is best-effort
    }
}

async function restoreDesktopSession() {
    const desktop = desktopBridge();
    if (!desktop?.loadSession) return null;
    try {
        const session = await desktop.loadSession();
        if (!session) return null;
        const user = asLocalUser(session.user);
        const accessToken = String(session.accessToken || "");
        const accessExpiresAt = Number(session.accessExpiresAt) || 0;
        const username = String(session.username || user?.username || "");
        const password = String(session.password || "");
        if (username || password) useUserStore.setState({ lastUsername: username || useUserStore.getState().lastUsername, lastPassword: password || useUserStore.getState().lastPassword });
        if (accessToken) {
            useUserStore.setState({
                user,
                accessToken,
                accessExpiresAt,
                lastUsername: username || useUserStore.getState().lastUsername,
                lastPassword: password || useUserStore.getState().lastPassword,
            });
        }
        return { username, password, user, accessToken, accessExpiresAt };
    } catch {
        return null;
    }
}

async function clearDesktopSessionFile() {
    const desktop = desktopBridge();
    if (!desktop?.clearSession) return;
    try {
        await desktop.clearSession();
    } catch {
        // ignore
    }
}

export const useUserStore = create<UserStore>()(
    persist(
        (set, get) => {
            const applySession = (session: WuxinSession) => {
                const user = mapWuxinUser(session.user);
                set({
                    user,
                    accessToken: session.accessToken,
                    accessExpiresAt: session.accessExpiresAt,
                    lastUsername: user.username || get().lastUsername,
                    sessionChecked: true,
                });
                // lastPassword is set by login() before applySession
                scheduleRefresh(session.accessExpiresAt);
                void persistDesktopSession();
            };
            const clear = () => {
                stopRefreshTimer();
                set({ user: null, accessToken: "", accessExpiresAt: 0, sessionChecked: true });
            };

            return {
                user: null,
                accessToken: "",
                accessExpiresAt: 0,
                lastUsername: "",
                lastPassword: "",
                hydrated: false,
                sessionChecked: false,
                login: async (username, password) => {
                    const name = username.trim();
                    set({ lastUsername: name, lastPassword: password });
                    const result = await loginWuxinUser(name, password);
                    if (result.type === "2fa") return { ok: false, flowToken: result.flowToken };
                    applySession(result.session);
                    return { ok: true };
                },
                register: async (payload) => {
                    const username = String(payload.username ?? "").trim();
                    const email = String(payload.email ?? "").trim();
                    const verificationCode = String(payload.verification_code ?? "").trim();
                    await registerWuxinUser({
                        username,
                        password: payload.password,
                        email,
                        verificationCode,
                        inviteCode: String(payload.aff_code ?? "").trim() || undefined,
                    });
                },
                complete2fa: async (flowToken, code) => {
                    applySession(await loginWuxinUser2fa(flowToken, code.trim()));
                },
                refresh: async () => {
                    try {
                        applySession(await refreshWuxinSession());
                        return true;
                    } catch {
                        if (isTokenFresh(get().accessToken, get().accessExpiresAt)) return false;
                        if (!sessionFileRestoreAttempted) {
                            sessionFileRestoreAttempted = true;
                            const restored = await restoreDesktopSession();
                            if (restored?.accessToken && isTokenFresh(restored.accessToken, restored.accessExpiresAt)) {
                                const user = restored.user || get().user;
                                if (user) {
                                    set({
                                        user,
                                        accessToken: restored.accessToken,
                                        accessExpiresAt: restored.accessExpiresAt,
                                        lastUsername: restored.username || user.username || get().lastUsername,
                                        sessionChecked: true,
                                    });
                                    scheduleRefresh(restored.accessExpiresAt);
                                    return true;
                                }
                            }
                            if (restored?.accessToken) {
                                try {
                                    const user = mapWuxinUser(await fetchWuxinSelf(restored.accessToken));
                                    set({
                                        user,
                                        accessToken: restored.accessToken,
                                        accessExpiresAt: restored.accessExpiresAt,
                                        lastUsername: user.username || restored.username || get().lastUsername,
                                        sessionChecked: true,
                                    });
                                    scheduleRefresh(restored.accessExpiresAt);
                                    void persistDesktopSession();
                                    return true;
                                } catch {
                                    // session.json token also rejected
                                }
                            }
                        }
                        clear();
                        return false;
                    }
                },
                bootstrap: () => {
                    if (bootstrapPromise) return bootstrapPromise;
                    const current = get();
                    if (!current.hydrated) return Promise.resolve();
                    if (current.sessionChecked && !current.accessToken) return Promise.resolve();
                    if (current.sessionChecked && current.user && isTokenFresh(current.accessToken, current.accessExpiresAt)) return Promise.resolve();
                    bootstrapPromise = (async () => {
                        try {
                            if (!get().accessToken) {
                                await restoreDesktopSession();
                            }
                            const { accessToken, accessExpiresAt } = get();
                            if (!accessToken) {
                                set({ sessionChecked: true });
                                return;
                            }
                            if (isTokenFresh(accessToken, accessExpiresAt)) {
                                try {
                                    set({ user: mapWuxinUser(await fetchWuxinSelf(accessToken)), sessionChecked: true });
                                    scheduleRefresh(accessExpiresAt);
                                    void persistDesktopSession();
                                    return;
                                } catch {
                                    // expired or rejected token: try refresh cookie
                                }
                            }
                            const refreshed = await get().refresh();
                            if (!refreshed && !get().sessionChecked) set({ sessionChecked: true });
                        } finally {
                            if (!get().sessionChecked) set({ sessionChecked: true });
                            bootstrapPromise = null;
                        }
                    })();
                    return bootstrapPromise;
                },
                logout: () => {
                    clear();
                    void persistDesktopSession();
                },
                clearSession: () => clear(),
            };
        },
        {
            name: USER_STORE_KEY,
            partialize: (state) => ({
                user: state.user,
                accessToken: state.accessToken,
                accessExpiresAt: state.accessExpiresAt,
                lastUsername: state.lastUsername,
                lastPassword: state.lastPassword,
            }),
            onRehydrateStorage: () => () => {
                useUserStore.setState({ hydrated: true });
                void useUserStore.getState().bootstrap();
            },
        },
    ),
);
