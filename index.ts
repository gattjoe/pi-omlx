import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";

const DEFAULT_OMLX_BASE_URL = "http://127.0.0.1:8000/v1";
const EXTENSION_KEY = Symbol.for("pi-omlx/loaded");

// typed stats response from /admin/api/stats — only fields actually read below

interface OmlxWaitingRequest {
    elapsed_seconds: number;
    prompt_tokens: number;
}

interface OmlxPrefilling {
    processed: number;
    total: number;
    eta: number | null;
    elapsed: number;
}

interface OmlxGenerating {
    elapsed_seconds: number;
    generated_tokens: number;
    tokens_per_second: number;
    max_tokens: number;
}

interface OmlxModel {
    id: string;
    estimated_size: number;
    is_loading: boolean;
    loading_remaining_seconds_estimate: number | null;
    waiting: OmlxWaitingRequest[];
    prefilling: OmlxPrefilling[];
    generating: OmlxGenerating[];
}

interface OmlxMemoryPressure {
    current_bytes: number;
    current_formatted: string;
    hard_formatted: string;
}

interface OmlxActiveModels {
    models: OmlxModel[];
    memory_pressure: OmlxMemoryPressure | null;
}

interface OmlxCacheModel {
    id: string;
    partial_tokens_skipped: number;
}

interface OmlxRuntimeCache {
    models: OmlxCacheModel[];
}

interface OmlxStatsResponse {
    active_models: OmlxActiveModels;
    runtime_cache: OmlxRuntimeCache;
}

function resolveOmlxConfig(): { apiRoot: string; apiKey: string } | null {
    const envUrl = process.env.OMLX_BASE_URL;
    const envKey = process.env.OMLX_API_KEY;

    if (envKey) {
        return { apiRoot: envUrl ? normalizeUrl(envUrl) : DEFAULT_OMLX_BASE_URL, apiKey: envKey };
    }

    const raw = AuthStorage.create().get("omlx");
    const key = raw?.type === "api_key" ? raw.key : raw?.type === "oauth" ? raw.access : null;
    if (!key) return null;
    return { apiRoot: normalizeUrl((raw as any)?.baseUrl ?? envUrl ?? ""), apiKey: key };
}

function normalizeUrl(raw: string): string {
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (!trimmed) return DEFAULT_OMLX_BASE_URL;
    return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function adminBase(cfg: { apiRoot: string } | null): string {
    return cfg ? cfg.apiRoot.replace(/\/v1$/, "") : DEFAULT_OMLX_BASE_URL.replace("/v1", "");
}

function adminUrl(): string {
    return adminBase(resolveOmlxConfig()) + "/admin/api/stats";
}

// state — current request model id from fetch intercept, used to find exact model in stats
let activeModelId: string | null = null;

// /admin/api/stats is gated by a signed admin session cookie, not by the same
// Bearer api_key that /v1 accepts — oMLX's require_admin() only reads
// omlx_admin_session, and /admin/api/login only accepts the server's *main*
// api_key (sub-keys are rejected by design). So: try to log in once per
// session to get a cookie; if that fails (e.g. our key is a sub-key), stop
// polling instead of hammering the endpoint every 300ms forever.
let adminSessionCookie: string | null = null;
let adminLoginFailed = false;

async function loginToAdmin(cfg: { apiRoot: string; apiKey: string }): Promise<boolean> {
    try {
        const res = await fetch(`${adminBase(cfg)}/admin/api/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: cfg.apiKey }),
        });
        if (!res.ok) return false;
        const setCookie = res.headers.get("set-cookie");
        const match = setCookie?.match(/omlx_admin_session=[^;]+/);
        if (!match) return false;
        adminSessionCookie = match[0];
        return true;
    } catch {
        return false;
    }
}

interface OmlxStreamUsage {
    prompt_eval_duration?: number;
    generation_duration?: number;
    prompt_tokens_per_second?: number;
    generation_tokens_per_second?: number;
}

let lastChunk: { usage: OmlxStreamUsage } | null = null;
let lastTpsDisplay: string | null = null;
let turnCtx: { ui: { setStatus(key: string, text: string | undefined): void; setWorkingMessage(msg: string): void }; hasUI: boolean } | null = null;
let poller: ReturnType<typeof setInterval> | null = null;
let lastCachedTokens = 0; // baseline partial_tokens_skipped when preparing starts

// ui helpers

function fmtTime(seconds: number | undefined): string {
    if (!seconds || seconds <= 0) return "";
    const ms = seconds * 1000;
    return ms < 1000 ? `${Math.round(ms)}ms` : `${seconds.toFixed(2).replace(/\.?0+$/, "")}s`;
}

function buildStatus(usage: OmlxStreamUsage): string {
    const tps = usage.generation_tokens_per_second ?? 0;
    const ptsp = usage.prompt_tokens_per_second ?? 0;
    let out = `↓${tps.toFixed(1)} tok/s`;
    const genT = fmtTime(usage.generation_duration);
    if (genT) out += ` (${genT})`;
    if (ptsp > 0) {
        let part = ` | In: ↑${ptsp.toFixed(1)} tok/s`;
        const promptT = fmtTime(usage.prompt_eval_duration);
        if (promptT) part += ` (${promptT})`;
        out += part;
    }
    return out;
}

function updateStatus(usage: OmlxStreamUsage) {
    const status = buildStatus(usage);
    if (status !== lastTpsDisplay) {
        lastTpsDisplay = status;
        if (turnCtx?.hasUI) turnCtx.ui.setStatus("omlx-tps", status);
    }
}

function updateWorking(msg: string) {
    if (turnCtx?.hasUI) turnCtx.ui.setWorkingMessage(msg);
}

// stats polling

let pollInFlight = false;

async function pollStats(): Promise<void> {
    if (adminLoginFailed || pollInFlight) return;
    pollInFlight = true;
    try {
        const cfg = resolveOmlxConfig();
        if (!cfg) return;

        if (!adminSessionCookie && !(await loginToAdmin(cfg))) {
            adminLoginFailed = true;
            return;
        }

        let res = await fetch(adminUrl(), { headers: { Cookie: adminSessionCookie! } });
        if (res.status === 401) {
            // Cookie expired or was never valid — one fresh login attempt before giving up.
            adminSessionCookie = null;
            if (!(await loginToAdmin(cfg))) {
                adminLoginFailed = true;
                return;
            }
            res = await fetch(adminUrl(), { headers: { Cookie: adminSessionCookie! } });
        }
        if (!res.ok) {
            adminLoginFailed = true;
            return;
        }

        const stats = await res.json() as OmlxStatsResponse;
        const am = stats.active_models;
        if (!am) return;

        // find the exact model for the current request, fallback to first
        const model = activeModelId
            ? am.models.find(m => m.id === activeModelId) ?? am.models[0]
            : am.models[0];
        if (!model) return;

        const mp = am.memory_pressure;
        const memCurrent = mp?.current_bytes ?? 0;
        const memUsed = mp?.current_formatted.toLowerCase() ?? "0gb";
        const memHard = mp?.hard_formatted.toLowerCase() ?? "0gb";
        const memTag = `${memUsed}/${memHard} used`;

        switch (true) {
            // model loading
            case model.is_loading: {
                const eta = model.loading_remaining_seconds_estimate ?? 0;
                const pct = (memCurrent / (model.estimated_size || 1)) * 100;
                updateWorking(`Loading model... (${pct.toFixed(1)}% complete, ${eta.toFixed(1)}s remaining, ${memTag})`);
                break;
            }

            // active prefill
            case model.prefilling.length > 0: {
                const p = model.prefilling[0];
                const total = p.total;
                const processed = p.processed;
                const pct = total > 0 ? (processed / total) * 100 : 0;
                // eta can be null early in prefill; calc from elapsed progress
                const eta = p.eta ?? (p.elapsed > 0 ? Math.round((p.elapsed / Math.max(processed, 1)) * (total - processed)) : 0);
                updateWorking(`Prefilling... (${pct.toFixed(1)}% complete, ${eta.toFixed(1)}s remaining, ${memTag})`);
                if (lastChunk?.usage) updateStatus(lastChunk.usage);
                break;
            }

            // active generation
            case model.generating.length > 0: {
                const g = model.generating[0];
                const speed = g.tokens_per_second;
                const elapsed = g.elapsed_seconds;
                const genPct = g.max_tokens > 0 ? (g.generated_tokens / g.max_tokens) * 100 : 0;
                updateWorking(`Generating... (${genPct.toFixed(1)}% tok budget, ${speed.toFixed(1)} tok/s, ${elapsed.toFixed(1)}s elapsed, ${memTag})`);
                if (lastChunk?.usage) updateStatus(lastChunk.usage);
                break;
            }

            // idle / preparing — track cache warmup progress
            default: {
                const waiting = model.waiting[0];
                const cacheModel = stats.runtime_cache?.models.find(c => c.id === model.id);
                const cachedTokens = cacheModel?.partial_tokens_skipped ?? 0;

                // reset baseline only when model is truly idle with no pending request
                if (!waiting) {
                    lastCachedTokens = cachedTokens;
                }
                const cachedDelta = waiting ? cachedTokens - lastCachedTokens : 0;

                const promptTokens = waiting?.prompt_tokens ?? 0;
                const cachedPct = promptTokens > 0 ? Math.min(100, Math.round((cachedDelta / promptTokens) * 100)) : 0;
                const queueTime = waiting?.elapsed_seconds ?? 0;

                let parts = [];
                if (cachedPct > 0) parts.push(`${cachedPct}% cached`);
                if (queueTime > 0) parts.push(`${queueTime.toFixed(1)}s queued`);
                parts.push(memTag);
                updateWorking(`Preparing... (${parts.join(', ')})`);
                if (lastChunk?.usage) updateStatus(lastChunk.usage);
                break;
            }
        }
    } catch { } finally {
        pollInFlight = false;
    }
}

// fetch interception

function captureOmlxTimings(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let buffer = "";
    const decoder = new TextDecoder();

    return new ReadableStream({
        async start(controller) {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    const jsonStr = line.slice(6);
                    if (jsonStr === "[DONE]") continue;
                    try {
                        const chunk = JSON.parse(jsonStr);
                        if (chunk.usage) {
                            lastChunk = { usage: chunk.usage };
                        }
                    } catch { }
                }

                controller.enqueue(value);
            }
            controller.close();
        },
        cancel(reason?: any) { reader.cancel(reason); },
    });
}

function ensureStreamOptions(input: any, init?: any): any {
    try {
        const payload = init?.body ?? (typeof input === "string" ? null : input?.body);
        if (!payload) return init;
        const p = typeof payload === "string" ? JSON.parse(payload) : payload;
        // grab model id for targeted stats lookup
        if (p?.model) activeModelId = p.model;
        if (!p.stream_options) {
            p.stream_options = { include_usage: true };
            const newBody = JSON.stringify(p);
            if (typeof input === "string") {
                return { ...init, body: newBody };
            } else if (input) {
                input.body = newBody;
            }
        }
    } catch { }
    return init;
}

function isOmlxRequest(input: any): boolean {
    const url = typeof input === "string" ? input : input?.url;
    return typeof url === "string" && url.includes("/chat/completions") && !!resolveOmlxConfig();
}

function stopPoller() {
    if (poller) clearInterval(poller);
    poller = null;
}

function resetState() {
    lastChunk = null;
    lastTpsDisplay = null;
    activeModelId = null;
    lastCachedTokens = 0;
    adminSessionCookie = null;
    adminLoginFailed = false;
    pollInFlight = false;
}

// extension entry

export default function (pi: ExtensionAPI): void {
    const globalState = globalThis as Record<PropertyKey, unknown>;
    if (globalState[EXTENSION_KEY]) return;
    globalState[EXTENSION_KEY] = true;

    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: any, init?: any) => {
        if (!isOmlxRequest(input)) return originalFetch(input, init);

        init = ensureStreamOptions(input, init);

        const response = await originalFetch(input, init);
        if (response.ok && response.body) {
            return new Response(captureOmlxTimings(response.body), {
                status: response.status,
                statusText: response.statusText,
                headers: new Headers(response.headers),
            });
        }
        return response;
    };

    pi.on("before_agent_start", (_event, ctx) => {
        resetState();
        turnCtx = ctx;
        if (!resolveOmlxConfig()) return; // skip polling if no config
        poller = setInterval(pollStats, 300);
    });

    pi.on("turn_end", (_event, ctx) => {
        stopPoller();
        if (lastChunk?.usage && ctx.hasUI) updateStatus(lastChunk.usage);
    });

    pi.on("session_shutdown", () => {
        resetState();
        turnCtx = null;
        stopPoller();
        globalThis.fetch = originalFetch;
        delete globalState[EXTENSION_KEY];
    });
}
