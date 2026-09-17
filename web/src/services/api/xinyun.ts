import axios from "axios";

import i18n from "@/i18n";
import { buildApiUrl, modelOptionName, withLocalProxy, type AiConfig } from "@/stores/use-config-store";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type XinyunMediaItem = string | { url: string; name?: string; type?: "first_frame" | "end_frame" | "last_frame" };

type RequestOptions = { signal?: AbortSignal };

type ImageCreateResponse = {
    id?: string;
    task_id?: string;
    status?: string;
    message?: string;
    error?: { message?: string };
    data?: {
        id?: string;
        task_id?: string;
        data?: { id?: string; task_id?: string };
        task?: { id?: string; task_id?: string };
    };
    task?: { id?: string; task_id?: string };
};

type ImageTaskResponse = {
    code?: string | number;
    message?: string;
    status?: string;
    result_url?: string;
    url?: string;
    result_urls?: string[];
    data?: {
        status?: string;
        fail_reason?: string;
        result_url?: string;
        url?: string;
        result_urls?: string[];
        progress?: string;
        data?: {
            status?: string;
            result_url?: string;
            url?: string;
            result_urls?: string[];
            fail_reason?: string;
        };
    };
    error?: { message?: string };
};

type VideoCreateResponse = {
    id?: string;
    task_id?: string;
    status?: string;
    data?: { id?: string; task_id?: string };
    error?: { message?: string };
};

type VideoTaskResponse = {
    id?: string;
    status?: string;
    progress?: number | string;
    result_urls?: string[];
    result_url?: string;
    error?: { message?: string; code?: string };
    data?: { status?: string; result_urls?: string[]; result_url?: string; fail_reason?: string };
};

type SyncImageResponse = {
    created?: number;
    data?: Array<{ url?: string; b64_json?: string }>;
    error?: { message?: string };
};

type ChatCompletionChunk = {
    choices?: Array<{ delta?: { content?: string }; message?: { content?: string }; finish_reason?: string | null }>;
    error?: { message?: string };
};

export function xinyunHeaders(config: Pick<AiConfig, "apiKey">, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export function xinyunUrl(config: Pick<AiConfig, "baseUrl">, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

export function resolveXinyunImageRatio(size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = value.match(/^(\d+)x(\d+)$/i);
    if (dimensions) {
        const width = Number(dimensions[1]);
        const height = Number(dimensions[2]);
        if (!width || !height) return undefined;
        const gcd = greatestCommonDivisor(width, height);
        return `${width / gcd}:${height / gcd}`;
    }
    if (value.includes(":")) return value;
    return undefined;
}

export function resolveXinyunImageResolution(quality: string, model = "") {
    const fromQuality = normalizeXinyunImageResolutionToken(quality);
    if (fromQuality) return fromQuality;
    const fromModel = String(model || "").match(/(?:^|[-_])(\d+)k(?:$|[-_])/i);
    if (fromModel) return `${fromModel[1]}K`;
    return undefined;
}

function normalizeXinyunImageResolutionToken(value: string) {
    const raw = value.trim();
    if (!raw || raw.toLowerCase() === "auto") return undefined;
    const lower = raw.toLowerCase();
    if (lower === "low" || lower === "1k" || lower === "standard") return "1K";
    if (lower === "medium" || lower === "2k" || lower === "hd") return "2K";
    if (lower === "high" || lower === "4k") return "4K";
    const match = lower.match(/^(\d+)k$/);
    if (match) return `${match[1]}K`;
    return undefined;
}

export function resolveXinyunVideoRatio(size: string) {
    return resolveXinyunImageRatio(size) || "16:9";
}

export function resolveXinyunVideoResolution(vquality: string) {
    const value = (vquality || "").trim().toLowerCase();
    if (value === "low") return "480p";
    if (value === "high") return "1080p";
    if (/^\d+p$/i.test(value)) return value.toLowerCase();
    return "720p";
}

export async function uploadXinyunMedia(config: Pick<AiConfig, "baseUrl" | "apiKey">, file: File, kind: "image" | "video" | "audio" = "image", options?: RequestOptions) {
    if (file.size > 32 * 1024 * 1024) throw new Error(apiText("requestFailed"));
    const body = new FormData();
    body.append("file", file, file.name || `upload.${kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3"}`);
    body.append("kind", kind);
    try {
        const response = await axios.post<{
            success?: boolean;
            data?: { url?: string; items?: Array<{ url?: string }> };
            url?: string;
            error?: { message?: string };
            message?: string;
        }>(xinyunUrl(config, "/media/upload"), body, { headers: xinyunHeaders(config), signal: options?.signal });
        const url =
            response.data?.data?.url ||
            response.data?.data?.items?.find((item) => item.url)?.url ||
            response.data?.url ||
            "";
        if (!url) throw new Error(apiText("requestFailed"));
        return url;
    } catch (error) {
        throw new Error(readXinyunAxiosError(error, apiText("requestFailed")));
    }
}

export async function ensureXinyunPublicUrl(config: Pick<AiConfig, "baseUrl" | "apiKey">, source: string | File, kind: "image" | "video" | "audio" = "image", options?: RequestOptions) {
    if (typeof source === "string") {
        if (/^https?:\/\//i.test(source)) return source;
        if (source.startsWith("data:")) {
            const file = dataUrlToFile(source, kind);
            return uploadXinyunMedia(config, file, kind, options);
        }
        throw new Error(apiText("requestFailed"));
    }
    return uploadXinyunMedia(config, source, kind, options);
}

export async function createXinyunImageTask(
    config: Pick<AiConfig, "baseUrl" | "apiKey" | "model" | "size" | "quality" | "systemPrompt">,
    prompt: string,
    referenceUrls: string[] = [],
    options?: RequestOptions,
) {
    const model = modelOptionName(config.model);
    const body: Record<string, unknown> = {
        model,
        prompt,
    };
    const ratio = resolveXinyunImageRatio(config.size);
    const resolution = resolveXinyunImageResolution(config.quality, model);
    if (ratio) {
        body.ratio = ratio;
        body.aspect_ratio = ratio;
    }
    if (resolution) body.resolution = resolution;
    if (referenceUrls.length === 1) body.image = referenceUrls[0];
    if (referenceUrls.length) body.images = referenceUrls;
    try {
        const response = await axios.post<ImageCreateResponse>(xinyunUrl(config, "/images/create"), body, {
            headers: xinyunHeaders(config, "application/json"),
            signal: options?.signal,
        });
        const taskId = extractXinyunTaskId(response.data);
        if (!taskId) {
            const hint = response.data.error?.message || response.data.message || apiText("noVideoTaskId");
            throw new Error(hint);
        }
        return String(taskId);
    } catch (error) {
        throw new Error(readXinyunAxiosError(error, apiText("requestFailed")));
    }
}

export async function pollXinyunImageTask(config: Pick<AiConfig, "baseUrl" | "apiKey">, taskId: string, options?: RequestOptions) {
    try {
        const response = await axios.get<ImageTaskResponse>(xinyunUrl(config, `/images/tasks/${encodeURIComponent(taskId)}`), {
            headers: xinyunHeaders(config),
            signal: options?.signal,
        });
        const payload = response.data;
        const status = extractXinyunImageTaskStatus(payload);
        if (status === "success" || status === "completed" || status === "succeeded") {
            const url = extractXinyunImageResultUrl(payload);
            if (!url) throw new Error(apiText("noImageReturned"));
            return { status: "completed" as const, url };
        }
        if (status === "failure" || status === "failed" || status === "error") {
            return {
                status: "failed" as const,
                error:
                    payload.data?.fail_reason ||
                    payload.data?.data?.fail_reason ||
                    payload.error?.message ||
                    payload.message ||
                    apiText("requestFailed"),
            };
        }
        return { status: "pending" as const };
    } catch (error) {
        throw new Error(readXinyunAxiosError(error, apiText("requestFailed")));
    }
}

export async function waitForXinyunImageTask(config: Pick<AiConfig, "baseUrl" | "apiKey">, taskId: string, options?: RequestOptions) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollXinyunImageTask(config, taskId, options);
        if (state.status === "completed") return state.url;
        if (state.status === "failed") throw new Error(state.error);
        await delay(2500, options?.signal);
    }
    throw new Error(apiText("requestFailed"));
}

/** @deprecated Task-plugin models must use create + poll; do not call /images/generations. */
export async function generateXinyunImageSync(
    config: Pick<AiConfig, "baseUrl" | "apiKey" | "model" | "size" | "quality">,
    prompt: string,
    n = 1,
    options?: RequestOptions,
) {
    const size = config.size.trim() && config.size.trim().toLowerCase() !== "auto" && /^\d+x\d+$/i.test(config.size.trim()) ? config.size.trim() : undefined;
    try {
        const response = await axios.post<SyncImageResponse>(
            xinyunUrl(config, "/images/generations"),
            {
                model: modelOptionName(config.model),
                prompt,
                n,
                ...(size ? { size } : {}),
            },
            { headers: xinyunHeaders(config, "application/json"), signal: options?.signal },
        );
        const images = (response.data.data || [])
            .map((item) => {
                if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
                return item.url || "";
            })
            .filter(Boolean);
        if (!images.length) throw new Error(apiText("noImageReturned"));
        return images;
    } catch (error) {
        throw new Error(readXinyunAxiosError(error, apiText("requestFailed")));
    }
}

export async function requestXinyunImages(
    config: Pick<AiConfig, "baseUrl" | "apiKey" | "model" | "size" | "quality" | "systemPrompt">,
    prompt: string,
    referenceUrls: string[] = [],
    n = 1,
    options?: RequestOptions,
) {
    const count = Math.max(1, Math.min(15, n));
    const urls = await Promise.all(
        Array.from({ length: count }, async () => {
            const taskId = await createXinyunImageTask(config, prompt, referenceUrls, options);
            return waitForXinyunImageTask(config, taskId, options);
        }),
    );
    return urls;
}

export async function createXinyunVideoTask(
    config: Pick<AiConfig, "baseUrl" | "apiKey" | "model" | "size" | "vquality" | "videoSeconds">,
    prompt: string,
    bodyExtras: {
        images?: XinyunMediaItem[];
        videos?: XinyunMediaItem[];
        audios?: XinyunMediaItem[];
    },
    options?: RequestOptions,
) {
    const duration = Math.max(1, Math.floor(Number(config.videoSeconds) || 5));
    const body: Record<string, unknown> = {
        model: modelOptionName(config.model),
        prompt,
        duration,
        ratio: resolveXinyunVideoRatio(config.size),
        resolution: resolveXinyunVideoResolution(config.vquality),
    };
    if (bodyExtras.images?.length) body.images = bodyExtras.images;
    if (bodyExtras.videos?.length) body.videos = bodyExtras.videos;
    if (bodyExtras.audios?.length) body.audios = bodyExtras.audios;
    try {
        const response = await axios.post<VideoCreateResponse>(xinyunUrl(config, "/video/generations"), body, {
            headers: xinyunHeaders(config, "application/json"),
            signal: options?.signal,
        });
        const taskId = response.data.task_id || response.data.id || response.data.data?.task_id || response.data.data?.id;
        if (!taskId) throw new Error(apiText("noVideoTaskId"));
        return String(taskId);
    } catch (error) {
        throw new Error(readXinyunAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

export async function pollXinyunVideoTask(config: Pick<AiConfig, "baseUrl" | "apiKey">, taskId: string, options?: RequestOptions) {
    try {
        const response = await axios.get<VideoTaskResponse>(xinyunUrl(config, `/videos/tasks/${encodeURIComponent(taskId)}`), {
            headers: xinyunHeaders(config),
            signal: options?.signal,
        });
        const payload = response.data;
        const status = String(payload.status || payload.data?.status || "").toLowerCase();
        if (status === "completed" || status === "success") {
            const urls = [
                ...(Array.isArray(payload.result_urls) ? payload.result_urls : []),
                ...(payload.result_url ? [payload.result_url] : []),
                ...(Array.isArray(payload.data?.result_urls) ? payload.data.result_urls : []),
                ...(payload.data?.result_url ? [payload.data.result_url] : []),
            ].filter(Boolean);
            if (!urls.length) return { status: "failed" as const, error: apiText("noPlayableVideo") };
            return { status: "completed" as const, url: urls[0] };
        }
        if (status === "failed" || status === "failure") {
            return {
                status: "failed" as const,
                error: payload.error?.message || payload.data?.fail_reason || apiText("videoGenerationFailed"),
            };
        }
        return { status: "pending" as const };
    } catch (error) {
        throw new Error(readXinyunAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

export async function streamXinyunChat(
    config: Pick<AiConfig, "baseUrl" | "apiKey" | "model">,
    messages: Array<{ role: string; content: unknown }>,
    onDelta?: (text: string) => void,
    options?: RequestOptions,
) {
    const response = await fetch(xinyunUrl(config, "/chat/completions"), {
        method: "POST",
        headers: { ...xinyunHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({
            model: modelOptionName(config.model),
            messages,
            stream: true,
        }),
        signal: options?.signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        let message = apiText("requestFailed");
        try {
            const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
            message = parsed.error?.message || parsed.message || message;
        } catch {
            if (text) message = text.slice(0, 300);
        }
        throw new Error(message);
    }
    if (!response.body) {
        const payload = (await response.json()) as ChatCompletionChunk;
        const content = payload.choices?.[0]?.message?.content || "";
        if (content) onDelta?.(content);
        return content;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
            const match = buffer.match(/\r?\n\r?\n/);
            if (!match) break;
            const index = match.index ?? 0;
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + match[0].length);
            const data = block
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^ /, ""))
                .join("\n")
                .trim();
            if (!data || data === "[DONE]") continue;
            try {
                const event = JSON.parse(data) as ChatCompletionChunk;
                if (event.error?.message) throw new Error(event.error.message);
                const delta = event.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta) {
                    text += delta;
                    onDelta?.(text);
                }
            } catch (error) {
                if (error instanceof Error && error.message && !error.message.includes("JSON")) throw error;
            }
        }
    }
    return text;
}


function extractXinyunTaskId(payload: ImageCreateResponse | Record<string, unknown> | null | undefined): string {
    if (!payload || typeof payload !== "object") return "";
    const record = payload as Record<string, unknown>;
    const candidates = [
        record.task_id,
        record.id,
        (record.data as Record<string, unknown> | undefined)?.task_id,
        (record.data as Record<string, unknown> | undefined)?.id,
        ((record.data as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.task_id,
        ((record.data as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.id,
        ((record.data as Record<string, unknown> | undefined)?.task as Record<string, unknown> | undefined)?.task_id,
        ((record.data as Record<string, unknown> | undefined)?.task as Record<string, unknown> | undefined)?.id,
        (record.task as Record<string, unknown> | undefined)?.task_id,
        (record.task as Record<string, unknown> | undefined)?.id,
    ];
    for (const value of candidates) {
        if (value == null || value === "") continue;
        return String(value);
    }
    return "";
}

function extractXinyunImageTaskStatus(payload: ImageTaskResponse) {
    const nested = payload.data?.data;
    const raw = payload.data?.status || nested?.status || payload.status || "";
    return String(raw).trim().toLowerCase();
}

function extractXinyunImageResultUrl(payload: ImageTaskResponse) {
    const nested = payload.data?.data;
    const list = [
        payload.data?.result_url,
        payload.data?.url,
        ...(Array.isArray(payload.data?.result_urls) ? payload.data.result_urls : []),
        nested?.result_url,
        nested?.url,
        ...(Array.isArray(nested?.result_urls) ? nested.result_urls : []),
        payload.result_url,
        payload.url,
        ...(Array.isArray(payload.result_urls) ? payload.result_urls : []),
    ];
    return list.map((item) => String(item || "").trim()).find(Boolean) || "";
}

function dataUrlToFile(dataUrl: string, kind: "image" | "video" | "audio") {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    const mime = match?.[1] || (kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg");
    const base64 = match?.[2] || "";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const ext = mime.includes("png") ? "png" : mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "bin";
    return new File([bytes], `upload.${ext}`, { type: mime });
}

function greatestCommonDivisor(a: number, b: number): number {
    let x = Math.abs(a);
    let y = Math.abs(b);
    while (y) {
        const next = x % y;
        x = y;
        y = next;
    }
    return x || 1;
}

function readXinyunAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError(error)) {
        const data = error.response?.data as { error?: { message?: string }; message?: string; msg?: string } | undefined;
        return data?.error?.message || data?.message || data?.msg || (error.response?.status ? `${fallback}（${error.response.status}）` : fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? error.message : fallback;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

// Keep proxy-aware absolute URL helper available for callers that download CDN results.
export function xinyunProxyUrl(url: string) {
    return withLocalProxy(url);
}
