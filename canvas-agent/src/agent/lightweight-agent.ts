import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { toolDescriptions, toolInputSchemas, toolNames } from "../canvas/schemas.js";
import { AGENT_PROMPT, CONFIG_DIR, loadConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "./types.js";

export class CodexSkillLookupError extends Error {
    statusCode: number;
    override name = "CodexSkillLookupError";
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
    }
}

type StoredMessage = { id: string; itemId: string; threadId: string; turnId: string; role: "user" | "assistant"; text: string };
type StoredThread = { id: string; cwd: string; name: string; preview: string; createdAt: number; updatedAt: number; messages: StoredMessage[]; settledTurnIds: string[] };
type ToolRunner = (name: string, input: Record<string, unknown>) => Promise<unknown>;

const threadFile = path.join(CONFIG_DIR, "agent-threads.json");
const skillStateFile = path.join(CONFIG_DIR, "skill-states.json");
let toolRunner: ToolRunner | null = null;
let activeController: AbortController | null = null;
let queue: Promise<unknown> = Promise.resolve();

export function configureLightweightAgent(runner: ToolRunner) {
    toolRunner = runner;
}

export function summarizeCodexThread(value: unknown) {
    const thread = value as StoredThread;
    return { id: String(thread.id || ""), cwd: String(thread.cwd || ""), name: thread.name || null, preview: String(thread.preview || ""), status: "idle", createdAt: Number(thread.createdAt || 0), updatedAt: Number(thread.updatedAt || 0) };
}

export async function startCodexThread(emit: AgentEmit, cwd = "", _permissionMode: AgentPermissionMode = "request", _preheat = false) {
    const now = Date.now();
    const thread: StoredThread = { id: crypto.randomUUID(), cwd, name: "", preview: "", createdAt: now, updatedAt: now, messages: [], settledTurnIds: [] };
    await mutateThreads((threads) => { threads.unshift(thread); });
    emitReady(emit, thread.id);
    return thread;
}

export async function resumeCodexThread(emit: AgentEmit, threadId: string, _cwd?: string, _permissionMode: AgentPermissionMode = "request", _preheat = false) {
    const thread = await getThread(threadId);
    emitReady(emit, thread.id);
    return historyResponse(thread);
}

export async function listCodexThreads(_emit: AgentEmit, options: { cwd?: string; searchTerm?: string; limit?: number }) {
    const search = String(options.searchTerm || "").trim().toLowerCase();
    const data = (await readThreads()).filter((thread) => (!options.cwd || samePath(thread.cwd, options.cwd)) && (!search || `${thread.name}\n${thread.preview}`.toLowerCase().includes(search))).slice(0, options.limit || 40).map(summarizeCodexThread);
    return { data, nextCursor: null, backwardsCursor: null };
}

export async function readCodexThread(_emit: AgentEmit, threadId: string, _cwd?: string) {
    return historyResponse(await getThread(threadId));
}

export async function archiveCodexThread(_emit: AgentEmit, threadId: string, _cwd?: string) {
    await mutateThreads((threads) => {
        const index = threads.findIndex((thread) => thread.id === threadId);
        if (index < 0) throw new CodexSkillLookupError("找不到指定对话", 404);
        threads.splice(index, 1);
    });
}

export async function listCodexModels(_emit: AgentEmit) {
    const config = aiConfig();
    return {
        data: config.textModels.map((model) => ({
            id: model,
            model,
            displayName: model,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "使用设置渠道中的文本模型" }],
            isDefault: model === config.textModel,
        })),
        nextCursor: null,
    };
}

export async function runCodexTurn(prompt: string, lifecycleEmit: AgentEmit, attachments: AgentAttachment[] = [], options: Record<string, unknown> = {}) {
    queue = queue.catch(() => undefined).then(() => runTurnNow(prompt, lifecycleEmit, attachments, options));
    await queue;
}

export async function interruptCodexTurn(_threadId?: string) {
    if (!activeController) return false;
    activeController.abort();
    return true;
}

export async function resolveCodexApproval(_requestId: string, _decision: string) {
    return false;
}

export function isRecoverableThreadError(error: unknown) {
    return /找不到指定对话|thread not found/i.test(error instanceof Error ? error.message : String(error));
}

export async function listCodexSkills(_emit: AgentEmit, cwd: string, _forceReload = false) {
    const roots = [path.join(cwd, ".agents", "skills"), path.join(cwd, ".codex", "skills")];
    const states = await readSkillStates();
    const skills: Array<Record<string, unknown>> = [];
    const errors: Array<{ path: string; message: string }> = [];
    for (const root of roots) {
        for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
            if (!entry.isDirectory()) continue;
            const skillPath = path.join(root, entry.name, "SKILL.md");
            try {
                const raw = await fs.readFile(skillPath, "utf8");
                const description = frontmatterValue(raw, "description") || firstBodyLine(raw) || entry.name;
                const displayName = frontmatterValue(raw, "display_name") || entry.name;
                skills.push({ name: entry.name, description, shortDescription: description.slice(0, 64), interface: { displayName }, path: skillPath, scope: "repo", enabled: states[skillPath] !== false });
            } catch (error) {
                errors.push({ path: skillPath, message: error instanceof Error ? error.message : String(error) });
            }
        }
    }
    return { cwd, skills, errors };
}

export async function resolveCodexSkill(emit: AgentEmit, cwd: string, selector: { name?: string; path?: string }, requireEnabled = false) {
    const found = (await listCodexSkills(emit, cwd, true)).skills.find((skill) => skill.name === selector.name && samePath(String(skill.path), String(selector.path)));
    if (!found) throw new CodexSkillLookupError("找不到指定 Skill，请刷新列表后重试", 404);
    if (requireEnabled && !found.enabled) throw new CodexSkillLookupError("该 Skill 已停用，请先启用后再使用", 409);
    return found;
}

export async function configureCodexSkill(emit: AgentEmit, cwd: string, selector: { name?: string; path?: string }, enabled: boolean) {
    const skill = await resolveCodexSkill(emit, cwd, selector);
    const states = await readSkillStates();
    states[String(skill.path)] = enabled;
    await writeJson(skillStateFile, states);
    return { effectiveEnabled: enabled, skill: { ...skill, enabled } };
}

export async function generateCodexSkillDraft(_emit: AgentEmit, cwd: string, input: { source?: string; threadId?: string; snapshot?: unknown; model?: string }) {
    const source = input.source === "conversation" ? JSON.stringify((await getThread(String(input.threadId))).messages) : JSON.stringify(input.snapshot);
    const schema = z.object({ name: z.string(), displayName: z.string(), description: z.string(), instructions: z.string(), shortDescription: z.string(), defaultPrompt: z.string() });
    const text = await simpleCompletion([{ role: "user", content: `请从以下内容提炼一个可复用 Skill，并只返回 JSON，字段为 name, displayName, description, instructions, shortDescription, defaultPrompt。name 只能使用小写字母数字和连字符，defaultPrompt 必须包含 $name。\n\n${source}` }], input.model);
    const parsed = schema.parse(JSON.parse(extractJson(text)));
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.name)) throw new Error("文本模型返回的 Skill 名称无效");
    return parsed;
}

async function runTurnNow(prompt: string, emit: AgentEmit, attachments: AgentAttachment[], options: Record<string, unknown>) {
    const thread = options.threadId ? await getThread(String(options.threadId)) : await startCodexThread((options.appEmit as AgentEmit) || emit, String(options.cwd || ""));
    const threadId = thread.id;
    const turnId = crypto.randomUUID();
    const assistantItemId = crypto.randomUUID();
    const controller = new AbortController();
    activeController = controller;
    (options.onStart as (() => void) | undefined)?.();
    (options.onThread as ((id: string) => void) | undefined)?.(threadId);
    (options.onTurn as ((id: string) => void) | undefined)?.(turnId);
    emit("turn.started", { threadId, turnId, turn: { id: turnId } });
    try {
        const skill = options.skill as { path?: string } | undefined;
        const skillText = skill?.path ? await fs.readFile(skill.path, "utf8") : "";
        const stored = await getThread(threadId);
        const messages: Array<Record<string, unknown>> = [
            { role: "system", content: `${AGENT_PROMPT}\n\n你是佳速画布内置 Agent。需要操作页面或画布时必须调用提供的工具；工具返回成功后再向用户说明结果。${aiConfig().systemPrompt ? `\n\n用户配置的系统提示词：\n${aiConfig().systemPrompt}` : ""}${skillText ? `\n\n当前 Skill：\n${skillText}` : ""}` },
            ...stored.messages.map((message) => ({ role: message.role, content: message.text })),
            { role: "user", content: userContent(prompt, attachments) },
        ];
        let finalText = "";
        let usage: unknown;
        for (let round = 0; round < 10; round++) {
            const result = await chatCompletion(messages, options.model as string | undefined, controller.signal);
            usage = result.usage;
            const message = result.choices?.[0]?.message;
            if (!message) throw new Error("文本模型未返回有效消息");
            const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
            const content = textContent(message.content);
            if (!toolCalls.length) {
                finalText = content;
                break;
            }
            messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });
            for (const call of toolCalls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
                const name = String(call.function?.name || "");
                const input = parseArguments(call.function?.arguments);
                const itemId = call.id || crypto.randomUUID();
                emit("item.started", { threadId, turnId, item: { id: itemId, type: "mcp_tool_call", server: "infinite-canvas", tool: name, status: "inProgress", arguments: input } });
                try {
                    if (!toolRunner) throw new Error("画布工具尚未初始化");
                    const toolResult = await toolRunner(name, input);
                    emit("item.completed", { threadId, turnId, item: { id: itemId, type: "mcp_tool_call", server: "infinite-canvas", tool: name, status: "completed", arguments: input, result: toolResult } });
                    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(toolResult) });
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    emit("item.completed", { threadId, turnId, item: { id: itemId, type: "mcp_tool_call", server: "infinite-canvas", tool: name, status: "failed", arguments: input, error: { message: errorMessage } } });
                    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: errorMessage }) });
                }
            }
        }
        if (!finalText) throw new Error("Agent 工具调用次数过多，请缩小任务范围后重试");
        emit("item.updated", { threadId, turnId, item: { id: assistantItemId, type: "agent_message", delta: finalText } });
        emit("item.completed", { threadId, turnId, item: { id: assistantItemId, type: "agent_message", text: finalText } });
        if (usage) emit("usage.updated", { threadId, turnId, usage });
        await appendTurn(threadId, turnId, String(options.messageText || prompt), finalText);
        emit("turn.completed", { threadId, turnId, status: "completed", turn: { id: turnId } });
    } catch (error) {
        const interrupted = controller.signal.aborted;
        const message = interrupted ? "任务已停止" : error instanceof Error ? error.message : String(error);
        if (!interrupted) emit("agent_error", { threadId, turnId, message });
        emit("turn.completed", { threadId, turnId, status: interrupted ? "interrupted" : "failed", error: { message }, turn: { id: turnId } });
        logger.error("Lightweight Agent turn failed", { threadId, turnId, error });
    } finally {
        if (activeController === controller) activeController = null;
        (options.onFinish as (() => void) | undefined)?.();
    }
}

async function chatCompletion(messages: Array<Record<string, unknown>>, requestedModel: string | undefined, signal: AbortSignal) {
    const config = aiConfig();
    const model = resolveTextModel(config, requestedModel);
    if (!config.apiKey || !config.baseUrl || !model) throw new Error("请先在设置渠道中填写 Base URL、API Key 和文本模型");
    const response = await fetch(chatUrl(config.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
            model,
            messages,
            tools: toolNames.map((name) => ({ type: "function", function: { name, description: toolDescriptions[name], parameters: zodToJsonSchema(toolInputSchemas[name], { target: "openApi3", $refStrategy: "none" }) } })),
            tool_choice: "auto",
            stream: false,
        }),
        signal,
    });
    const body = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>; usage?: unknown; error?: unknown; message?: string } | null;
    if (!response.ok) throw new Error(compatibleApiError(response.status, body));
    return body as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>; usage?: unknown };
}

async function simpleCompletion(messages: Array<Record<string, unknown>>, requestedModel?: string) {
    const config = aiConfig();
    const model = resolveTextModel(config, requestedModel);
    if (!config.apiKey || !config.baseUrl || !model) throw new Error("请先在设置渠道中填写 Base URL、API Key 和文本模型");
    const response = await fetch(chatUrl(config.baseUrl), { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages, stream: false }) });
    const body = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }>; error?: unknown; message?: string } | null;
    if (!response.ok) throw new Error(compatibleApiError(response.status, body, false));
    return textContent(body?.choices?.[0]?.message?.content);
}

function aiConfig() {
    const ai = (loadConfig() as { ai?: Record<string, unknown> }).ai || {};
    const textModel = String(ai.textModel || "").trim();
    const textModels = Array.from(new Set([textModel, ...(Array.isArray(ai.textModels) ? ai.textModels : [])].map((model) => String(model || "").trim()).filter(Boolean)));
    return { baseUrl: String(ai.baseUrl || "").trim(), apiKey: String(ai.apiKey || "").trim(), textModel, textModels, systemPrompt: String(ai.systemPrompt || "") };
}

function resolveTextModel(config: ReturnType<typeof aiConfig>, requestedModel?: string) {
    const requested = String(requestedModel || "").trim();
    if (!requested) return config.textModel || config.textModels[0] || "";
    if (!config.textModels.includes(requested)) throw new Error("所选文本模型已不在设置渠道中，请刷新模型后重新选择");
    return requested;
}

function chatUrl(baseUrl: string) {
    const base = baseUrl.replace(/\/+$/, "");
    return `${/\/(?:v1|api\/v\d+)$/i.test(base) ? base : `${base}/v1`}/chat/completions`;
}

function userContent(prompt: string, attachments: AgentAttachment[]) {
    const images = attachments.flatMap((item) => item.dataUrl?.startsWith("data:image/") ? [{ type: "image_url", image_url: { url: item.dataUrl } }] : []);
    return images.length ? [{ type: "text", text: prompt }, ...images] : prompt;
}

function textContent(value: unknown) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((item) => item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text || "") : "").filter(Boolean).join("\n");
    return "";
}

function parseArguments(value?: string) {
    try {
        return JSON.parse(value || "{}") as Record<string, unknown>;
    } catch {
        return {};
    }
}

function apiError(body: { error?: unknown; message?: string } | null) {
    const error = body?.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message || "");
    return typeof body?.message === "string" ? body.message : "";
}

function compatibleApiError(status: number, body: { error?: unknown; message?: string } | null, usesTools = true) {
    const detail = apiError(body);
    if (usesTools && /(?:tool_calls?|function.?call|tools?).*(?:unsupported|not supported|unknown|invalid)|(?:unsupported|not supported).*(?:tool_calls?|function.?call|tools?)/i.test(detail)) {
        return "当前文本模型不支持标准 tools/tool_calls，无法执行画布操作。请在设置渠道中选择支持工具调用的文本模型";
    }
    return detail || `文本模型请求失败（HTTP ${status}）`;
}

function emitReady(emit: AgentEmit, threadId: string) {
    emit("agent_bootstrap", { type: "mcp.complete", phase: "preheat", threadId, services: [{ name: "infinite-canvas", authStatus: "unsupported" }] });
}

function historyResponse(thread: StoredThread) {
    return { thread: summarizeCodexThread(thread), messages: thread.messages, settledTurnIds: thread.settledTurnIds, historyReady: true };
}

async function appendTurn(threadId: string, turnId: string, userText: string, assistantText: string) {
    await mutateThreads((threads) => {
        const thread = threads.find((item) => item.id === threadId);
        if (!thread) throw new Error("找不到指定对话");
        thread.messages.push({ id: `${threadId}:${turnId}:synthetic:user`, itemId: "synthetic:user", threadId, turnId, role: "user", text: userText }, { id: `${threadId}:${turnId}:assistant`, itemId: "assistant", threadId, turnId, role: "assistant", text: assistantText });
        thread.settledTurnIds.push(turnId);
        thread.preview ||= userText.slice(0, 120);
        thread.name ||= userText.slice(0, 40);
        thread.updatedAt = Date.now();
    });
}

async function getThread(threadId: string) {
    const thread = (await readThreads()).find((item) => item.id === threadId);
    if (!thread) throw new Error("找不到指定对话");
    return thread;
}

async function readThreads(): Promise<StoredThread[]> {
    try {
        return JSON.parse(await fs.readFile(threadFile, "utf8")).threads || [];
    } catch {
        return [];
    }
}

async function mutateThreads(mutator: (threads: StoredThread[]) => void) {
    const threads = await readThreads();
    mutator(threads);
    await writeJson(threadFile, { threads });
}

async function readSkillStates(): Promise<Record<string, boolean>> {
    try {
        return JSON.parse(await fs.readFile(skillStateFile, "utf8"));
    } catch {
        return {};
    }
}

async function writeJson(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2));
    await fs.rename(temporary, file);
}

function frontmatterValue(raw: string, key: string) {
    const match = raw.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "mi"));
    return match?.[1]?.trim() || "";
}

function firstBodyLine(raw: string) {
    return raw.replace(/^---[\s\S]*?---\s*/, "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function extractJson(value: string) {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("文本模型未返回有效 JSON");
    return match[0];
}

function samePath(left: string, right: string) {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
