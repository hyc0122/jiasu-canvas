import axios, { isAxiosError } from "axios";

import { getAuthBaseUrl } from "@/constant/auth";
import i18n from "@/i18n";

type WuxinApiResponse<T = unknown> = {
    success?: boolean;
    message?: string;
    code?: string;
    data?: T;
};

export type WuxinUser = {
    id: number | string;
    username?: string;
    display_name?: string;
    group?: string;
    quota?: number;
    used_quota?: number;
    role?: number;
    status?: number;
};

export type WuxinSession = {
    accessToken: string;
    accessExpiresAt: number;
    user: WuxinUser;
};

export type WuxinLoginResult = { type: "session"; session: WuxinSession } | { type: "2fa"; flowToken: string; expiresAt: number };

export type WuxinRegisterPayload = {
    username: string;
    password: string;
    email: string;
    verificationCode: string;
    inviteCode?: string;
};

const client = axios.create({
    baseURL: getAuthBaseUrl(),
    withCredentials: true,
    timeout: 20_000,
});

function authText(key: string) {
    return i18n.t(`auth.${key}`);
}

function errorMessage(error: unknown) {
    if (isAxiosError(error)) {
        const payload = error.response?.data as WuxinApiResponse | string | undefined;
        if (payload && typeof payload === "object" && payload.message) return String(payload.message);
        if (error.message === "Network Error") return authText("networkError");
    }
    if (error instanceof Error && error.message) return error.message;
    return authText("requestFailed");
}

function unwrap<T>(payload: WuxinApiResponse<T>): T {
    if (!payload?.success) throw new Error(payload?.message || authText("requestFailed"));
    return payload.data as T;
}

function defaultExpiresAt() {
    return Math.floor(Date.now() / 1000) + 15 * 60;
}

function asUser(value: unknown): WuxinUser | null {
    if (!value || typeof value !== "object") return null;
    const user = value as WuxinUser;
    if (user.id === undefined || user.id === null || user.id === "") return null;
    return user;
}

function asSession(data: unknown): WuxinSession | null {
    if (!data || typeof data !== "object") return null;
    const payload = data as { access_token?: unknown; access_expires_at?: unknown; user?: unknown };
    if (typeof payload.access_token !== "string" || !payload.access_token) return null;
    return {
        accessToken: payload.access_token,
        accessExpiresAt: typeof payload.access_expires_at === "number" && payload.access_expires_at > 0 ? payload.access_expires_at : defaultExpiresAt(),
        user: asUser(payload.user) || { id: "", username: "" },
    };
}

type DesktopAuthSpec = {
    method?: string;
    path: string;
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
};

function desktopAuth() {
    if (typeof window === "undefined") return undefined;
    return window.interfaceCanvasDesktop?.wuxinAuth;
}

async function requestPayload<T>(spec: DesktopAuthSpec & { withCredentials?: boolean }): Promise<WuxinApiResponse<T>> {
    const bridge = desktopAuth();
    if (bridge) {
        const result = await bridge({
            method: spec.method || "GET",
            path: spec.path,
            params: spec.params,
            body: spec.body,
            headers: spec.headers,
        });
        return (result?.data || { success: false, message: authText("requestFailed") }) as WuxinApiResponse<T>;
    }

    const { data } = await client.request<WuxinApiResponse<T>>({
        method: spec.method || "GET",
        url: spec.path,
        params: spec.params,
        data: spec.body,
        headers: spec.headers,
        withCredentials: spec.withCredentials !== false,
        timeout: 20_000,
    });
    return data;
}

async function request<T>(input: (() => Promise<{ data: WuxinApiResponse<T> }>) | (DesktopAuthSpec & { withCredentials?: boolean })): Promise<T> {
    try {
        if (typeof input === "function") {
            const { data } = await input();
            return unwrap(data);
        }
        return unwrap(await requestPayload<T>(input));
    } catch (error) {
        throw new Error(errorMessage(error));
    }
}

export async function sendEmailVerification(email: string) {
    const address = String(email ?? "").trim();
    if (!address) throw new Error(authText("emailRequired"));
    await request({
        method: "GET",
        path: "/api/verification",
        params: { email: address, turnstile: "" },
        withCredentials: false,
    });
}

export async function registerWuxinUser(payload: WuxinRegisterPayload) {
    const body: Record<string, string> = {
        username: payload.username,
        password: payload.password,
        email: payload.email,
        verification_code: payload.verificationCode,
    };
    const inviteCode = payload.inviteCode?.trim();
    if (inviteCode) body.aff_code = inviteCode;
    await request({ method: "POST", path: "/api/user/register", params: { turnstile: "" }, body });
}

async function readLoginResult(data: WuxinApiResponse<unknown>): Promise<WuxinLoginResult> {
    const payload = unwrap(data);
    if (payload && typeof payload === "object" && (payload as { require_2fa?: unknown }).require_2fa === true) {
        const flowToken = String((payload as { flow_token?: unknown }).flow_token || "");
        if (!flowToken) throw new Error(authText("requestFailed"));
        return { type: "2fa", flowToken, expiresAt: Number((payload as { expires_at?: unknown }).expires_at) || 0 };
    }
    const session = asSession(payload);
    if (!session?.accessToken) throw new Error(authText("requestFailed"));
    if (!asUser(session.user)) session.user = await fetchWuxinSelf(session.accessToken);
    return { type: "session", session };
}

export async function loginWuxinUser(username: string, password: string) {
    try {
        const data = await requestPayload({
            method: "POST",
            path: "/api/user/login",
            params: { turnstile: "" },
            body: { username, password },
        });
        return await readLoginResult(data);
    } catch (error) {
        throw new Error(errorMessage(error));
    }
}

export async function loginWuxinUser2fa(flowToken: string, code: string) {
    try {
        const data = await requestPayload({
            method: "POST",
            path: "/api/user/login/2fa",
            body: { flow_token: flowToken, code },
        });
        const result = await readLoginResult(data);
        if (result.type !== "session") throw new Error(authText("requestFailed"));
        return result.session;
    } catch (error) {
        throw new Error(errorMessage(error));
    }
}

export async function fetchWuxinSelf(accessToken: string) {
    const user = await request({ method: "GET", path: "/api/user/self", headers: { Authorization: `Bearer ${accessToken}` } });
    if (!asUser(user)) throw new Error(authText("requestFailed"));
    return user;
}

export async function fetchWuxinSubscription(accessToken: string) {
    return request({ method: "GET", path: "/api/subscription/self", headers: { Authorization: `Bearer ${accessToken}` } });
}

export async function refreshWuxinSession() {
    try {
        const data = await requestPayload({ method: "POST", path: "/api/user/auth/refresh", body: {} });
        const payload = unwrap(data);
        const session = asSession(payload);
        if (!session?.accessToken) throw new Error(authText("requestFailed"));
        if (!asUser(session.user)) session.user = await fetchWuxinSelf(session.accessToken);
        return session;
    } catch (error) {
        throw new Error(errorMessage(error));
    }
}

export async function sendPasswordResetEmail(email: string) {
    const address = String(email ?? "").trim();
    if (!address) throw new Error(authText("emailRequired"));
    await request({
        method: "GET",
        path: "/api/reset_password",
        params: { email: address, turnstile: "" },
        withCredentials: false,
    });
}

export async function confirmPasswordReset(email: string, token: string) {
    const address = String(email ?? "").trim();
    const resetToken = String(token ?? "").trim();
    if (!address) throw new Error(authText("emailRequired"));
    if (!resetToken) throw new Error(authText("resetTokenRequired"));
    const password = await request<string>({
        method: "POST",
        path: "/api/user/reset",
        body: { email: address, token: resetToken },
        withCredentials: false,
    });
    if (typeof password !== "string" || !password) throw new Error(authText("requestFailed"));
    return password;
}
