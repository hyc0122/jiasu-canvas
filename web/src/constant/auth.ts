/** Wuxin console (login / register / membership). Host must stay on this domain. */
export const WUXIN_CONSOLE_BASE = "https://www.wuxin-ai.xyz";

/** Wuxin model API. Do not send login access_token here. */
export const WUXIN_API_BASE = "https://api.wuxin-ai.xyz";

export const AUTH_DEV_PROXY_PREFIX = "/__wuxin";

export function getAuthBaseUrl() {
    return import.meta.env.DEV ? AUTH_DEV_PROXY_PREFIX : WUXIN_CONSOLE_BASE;
}
