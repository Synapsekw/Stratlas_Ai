/**
 * The person's own local model server (AI-9, decision 1: nothing bundled). Discovery of Ollama and
 * OpenAI-compatible servers (LM Studio, the llama.cpp server, vLLM), the capability probe, the
 * route checks against what the probe found, and the budgets that keep small models working.
 * Main process only (the probe uses the AI SDK); the renderer uses `routes.ts`.
 *
 * Nothing here logs a prompt or a key. Requests go only to the address given, which the caller
 * has checked (loopback, or a LAN address while cloud AI is allowed).
 */
import type { AiTask, LocalModelInfo, LocalModelSettings } from '@aio/schema';
import { APICallError, generateText, RetryError, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { describeError, isNetworkError } from './errors';
import { openAiBase, PROVIDER_LABELS, serverRoot } from './routes';

export { openAiBase, serverRoot };

export type LocalServerKind = 'ollama' | 'openai-compatible';

/** Steps per message in the compact profile (small models lose track in long loops). */
export const COMPACT_MAX_STEPS = 6;
/** Wait for the first token: a local model may need to load into memory first. */
export const DEFAULT_LOCAL_TIMEOUT_MS = 120_000;
/** Each discovery request; a server on this machine answers its model list at once. */
const DISCOVERY_TIMEOUT_MS = 5_000;
/** `/api/show` calls at most, so a server with a hundred models still answers quickly. */
const MAX_SHOW = 24;

/** An 8 x 8 px red PNG: the image of the vision probe. */
const PROBE_IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=';

// ---------------------------------------------------------------- parsers

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const posInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
const nonNeg = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;

/** Drop the keys whose value is undefined (exactOptionalPropertyTypes). */
function clean<T extends Obj>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Ollama `GET /api/tags`. */
export function parseOllamaTags(json: unknown): LocalModelInfo[] {
  if (!isObj(json) || !Array.isArray(json.models)) return [];
  const out: LocalModelInfo[] = [];
  for (const m of json.models) {
    if (!isObj(m)) continue;
    const id = str(m.name) ?? str(m.model);
    if (!id || id.length > 200) continue;
    const details = isObj(m.details) ? m.details : {};
    out.push(
      clean({
        id,
        name: id,
        sizeBytes: nonNeg(m.size),
        family: str(details.family),
        quantization: str(details.quantization_level),
      }),
    );
  }
  return out;
}

export interface OllamaShow {
  contextTokens?: number;
  tools?: boolean;
  vision?: boolean;
  /** False for embedding-only models, which cannot chat. */
  completion?: boolean;
}

/** Ollama `POST /api/show`: the context length and the capabilities the server claims. */
export function parseOllamaShow(json: unknown): OllamaShow {
  if (!isObj(json)) return {};
  const out: OllamaShow = {};
  if (isObj(json.model_info)) {
    for (const [k, v] of Object.entries(json.model_info)) {
      const n = posInt(v);
      if (k.endsWith('.context_length') && n) out.contextTokens = n;
    }
  }
  if (Array.isArray(json.capabilities)) {
    const caps = json.capabilities.filter((c): c is string => typeof c === 'string');
    out.tools = caps.includes('tools');
    out.vision = caps.includes('vision');
    out.completion = caps.includes('completion');
  }
  return out;
}

/** `GET /v1/models` of any OpenAI-compatible server (llama.cpp adds `meta.n_ctx_train`). */
export function parseOpenAiModels(json: unknown): LocalModelInfo[] {
  if (!isObj(json) || !Array.isArray(json.data)) return [];
  const out: LocalModelInfo[] = [];
  for (const m of json.data) {
    if (!isObj(m)) continue;
    const id = str(m.id);
    if (!id || id.length > 200) continue;
    const meta = isObj(m.meta) ? m.meta : {};
    out.push(clean({ id, contextTokens: posInt(meta.n_ctx_train), sizeBytes: nonNeg(meta.size) }));
  }
  return out;
}

export type LmStudioExtra = Partial<Omit<LocalModelInfo, 'id'>> & { embedding?: boolean };

/** LM Studio `GET /api/v0/models`: type (llm, vlm, embeddings), context and tool use. */
export function parseLmStudioModels(json: unknown): Map<string, LmStudioExtra> {
  const out = new Map<string, LmStudioExtra>();
  if (!isObj(json) || !Array.isArray(json.data)) return out;
  for (const m of json.data) {
    if (!isObj(m)) continue;
    const id = str(m.id);
    if (!id) continue;
    const type = str(m.type);
    const contextTokens = posInt(m.max_context_length);
    if (type === 'embeddings') {
      out.set(id, clean({ embedding: true, contextTokens }));
      continue;
    }
    const caps = Array.isArray(m.capabilities) ? m.capabilities : undefined;
    out.set(
      id,
      clean({
        contextTokens,
        tools: caps ? caps.includes('tool_use') : undefined,
        vision: type === 'vlm' ? true : type === 'llm' ? false : undefined,
        quantization: str(m.quantization),
        family: str(m.arch),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- discovery

export interface DiscoverOptions {
  /** The address as typed (`http://localhost:11434/v1`, `http://127.0.0.1:1234`). */
  baseUrl: string;
  /** Optional bearer key of the server, from the OS vault. Never logged. */
  key?: string | null;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export type DiscoverResult =
  | { ok: true; server: { kind: LocalServerKind; version?: string }; models: LocalModelInfo[] }
  | { ok: false; error: string };

type Got = { ok: true; json: unknown } | { ok: false; status?: number; network?: boolean };

/**
 * List the chat models of the server at `baseUrl`: Ollama first (`/api/version`, `/api/tags`,
 * `/api/show` per model), else the OpenAI-compatible list (`/v1/models`, with LM Studio's
 * `/api/v0/models` details when it has them). Embedding-only models are left out.
 */
export async function discoverLocalModels(opts: DiscoverOptions): Promise<DiscoverResult> {
  const fetch = opts.fetch ?? globalThis.fetch;
  const root = serverRoot(opts.baseUrl);
  const headers: Record<string, string> = opts.key ? { authorization: `Bearer ${opts.key}` } : {};

  async function get(url: string, body?: unknown): Promise<Got> {
    const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const res = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, json: (await res.json()) as unknown };
    } catch (e) {
      return { ok: false, network: isNetworkError(e) || isAbort(e) };
    }
  }

  // Ollama answers its version; LM Studio answers unknown paths with an error object.
  const version = await get(`${root}/api/version`);
  const ollamaVersion = version.ok && isObj(version.json) ? str(version.json.version) : undefined;
  if (ollamaVersion !== undefined) {
    const tags = await get(`${root}/api/tags`);
    if (!tags.ok) return { ok: false, error: listError(root, tags, opts.key) };
    const listed = parseOllamaTags(tags.json);
    const shows = await Promise.all(
      listed.map((m, i) =>
        i < MAX_SHOW
          ? get(`${root}/api/show`, { model: m.id }).then((r) =>
              r.ok ? parseOllamaShow(r.json) : {},
            )
          : Promise.resolve<OllamaShow>({}),
      ),
    );
    const models = listed.flatMap((m, i) => {
      const { completion, ...show } = shows[i] ?? {};
      return completion === false ? [] : [{ ...m, ...show }];
    });
    if (models.length === 0) return { ok: false, error: noModels(root) };
    return { ok: true, server: { kind: 'ollama', version: ollamaVersion }, models };
  }

  const list = await get(`${openAiBase(opts.baseUrl)}/models`);
  if (!list.ok) return { ok: false, error: listError(root, list, opts.key) };
  if (!isObj(list.json) || !Array.isArray(list.json.data)) {
    return {
      ok: false,
      error: `The server at ${root} did not answer like Ollama or an OpenAI-compatible server.`,
    };
  }
  const lmStudio = await get(`${root}/api/v0/models`);
  const extra = lmStudio.ok ? parseLmStudioModels(lmStudio.json) : new Map<string, LmStudioExtra>();
  const models = parseOpenAiModels(list.json).flatMap((m) => {
    const { embedding, ...more } = extra.get(m.id) ?? {};
    if (embedding) return [];
    return [clean({ ...m, ...more })];
  });
  if (models.length === 0) return { ok: false, error: noModels(root) };
  return { ok: true, server: { kind: 'openai-compatible' }, models };
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
}

function noModels(root: string): string {
  return `The server at ${root} has no models yet. Download a model with tool calling in Ollama or LM Studio, then try again.`;
}

function listError(root: string, got: Extract<Got, { ok: false }>, key?: string | null): string {
  if (got.network || got.status === undefined) {
    return `Nothing answers at ${root}. Start Ollama, LM Studio or the llama.cpp server, then try again.`;
  }
  if (got.status === 401 || got.status === 403) {
    return key
      ? `The server at ${root} did not accept the server key. Check it under Server key.`
      : `The server at ${root} wants a key. Add it under Server key, then try again.`;
  }
  return `The server at ${root} did not list its models (HTTP ${String(got.status)}).`;
}

// ---------------------------------------------------------------- probe

export interface ProbeOptions {
  model: LanguageModel;
  /** What discovery says about vision; `false` skips the image request. */
  claimsVision?: boolean | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  now?: () => number;
}

export type ProbeResult =
  { ok: true; tools: boolean; vision: boolean; latencyMs: number } | { ok: false; error: string };

class ProbeTimeout extends Error {}

/** Run `call` with an abort signal that fires after `ms` (or on `outer`); reject on time out. */
async function timed<T>(
  ms: number,
  outer: AbortSignal | undefined,
  call: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T> {
  const controller = new AbortController();
  const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProbeTimeout());
    }, ms);
  });
  try {
    return await Promise.race([call(signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The capability probe (`ai:localProbe`): one tiny tool-call request (its time is the latency
 * shown in Settings), then one tiny image request unless the server says the model has no
 * vision. A model that refuses tools, or answers in text instead of calling the tool, has no
 * tool calling; the agent then answers in text only.
 */
export async function probeLocalModel(opts: ProbeOptions): Promise<ProbeResult> {
  const ms = opts.timeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const label = PROVIDER_LABELS.local;
  let tools: boolean;
  const start = now();
  try {
    const r = await timed(ms, opts.signal, (abortSignal) =>
      generateText({
        model: opts.model,
        prompt: 'Call the tool named ready with ok set to true. Do not write anything else.',
        tools: {
          ready: tool({
            description: 'Say that you are ready.',
            inputSchema: z.object({ ok: z.boolean() }),
          }),
        },
        maxOutputTokens: 512,
        maxRetries: 0,
        abortSignal,
      }),
    );
    tools = r.toolCalls.some((c) => c.toolName === 'ready');
  } catch (e) {
    if (e instanceof ProbeTimeout) return { ok: false, error: timeoutMessage(ms) };
    if (!isToolsUnsupported(e)) {
      const model = modelIdOf(opts.model);
      return { ok: false, error: describeError(e, model ? { label, model } : { label }).message };
    }
    tools = false;
  }
  const latencyMs = Math.max(0, now() - start);

  let vision = false;
  if (opts.claimsVision !== false) {
    try {
      const r = await timed(ms, opts.signal, (abortSignal) =>
        generateText({
          model: opts.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What colour is this image? Answer with one word.' },
                { type: 'file', data: PROBE_IMAGE, mediaType: 'image/png' },
              ],
            },
          ],
          maxOutputTokens: 512,
          maxRetries: 0,
          abortSignal,
        }),
      );
      vision = /\b(red|crimson|scarlet)\b/i.test(r.text);
    } catch {
      vision = false;
    }
  }
  return { ok: true, tools, vision, latencyMs };
}

function modelIdOf(model: LanguageModel): string | undefined {
  return typeof model === 'string' ? model : model.modelId;
}

/** "The model did not answer within 120 s." */
export function timeoutMessage(ms: number): string {
  return `The model did not answer within ${String(Math.ceil(ms / 1000))} s. It may still be loading: try again.`;
}

/** The 4xx a server gives for a request with tools to a model without tool calling. */
export function isToolsUnsupported(err: unknown): boolean {
  const e = RetryError.isInstance(err) ? err.lastError : err;
  if (!APICallError.isInstance(e)) return false;
  const s = e.statusCode;
  if (s === undefined || s < 400 || s >= 500 || s === 401 || s === 403 || s === 404) return false;
  return /\btools?\b|function call/i.test(`${e.message} ${e.responseBody ?? ''}`);
}

// ---------------------------------------------------------------- runtime checks and budgets

/** Tasks the agent runs with tools; on a model without tool calling they answer in text only. */
const TOOL_TASKS: readonly AiTask[] = ['chat', 'build'];

/**
 * A route on the local model checked against what the probe found: `answer-only` for a tool task
 * on a model without tool calling, `no-vision` for the vision route on a model without vision.
 * A model that was never probed is trusted.
 */
export function localGate(
  cfg: LocalModelSettings | undefined,
  task: AiTask,
): 'answer-only' | 'no-vision' | null {
  const caps = cfg?.capabilities;
  if (!caps) return null;
  if (task === 'vision' && !caps.vision) return 'no-vision';
  if (TOOL_TASKS.includes(task) && !caps.tools) return 'answer-only';
  return null;
}

/** Output tokens per step: a quarter of the context window, 512 to 16 000. */
export function outputBudget(contextTokens: number | undefined): number {
  if (!contextTokens) return 16_000;
  return Math.min(16_000, Math.max(512, Math.floor(contextTokens / 4)));
}

export interface PlainMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Characters per token, roughly, for English text and JSON. */
const CHARS_PER_TOKEN = 4;
/** Share of the context window the conversation may take (the rest: prompt, tools, answer). */
const HISTORY_SHARE = 0.4;
const SUMMARY_PART = 160;
const SUMMARY_MAX = 1000;

/**
 * Keep the newest turns that fit in the history budget of a small context window; the older ones
 * become a short running summary for the instructions. The newest message is always kept.
 */
export function trimConversation<M extends PlainMessage>(
  messages: readonly M[],
  contextTokens: number | undefined,
): { messages: M[]; summary: string | null } {
  if (!contextTokens || messages.length <= 1) return { messages: [...messages], summary: null };
  const budget = contextTokens * CHARS_PER_TOKEN * HISTORY_SHARE;
  let used = 0;
  let first = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = messages[i]?.content.length ?? 0;
    if (i < messages.length - 1 && used + size > budget) break;
    used += size;
    first = i;
  }
  if (first === 0) return { messages: [...messages], summary: null };
  const dropped = messages.slice(0, first);
  const parts = dropped.map((m) => {
    const text = m.content.replace(/\s+/g, ' ').trim();
    const cut = text.length > SUMMARY_PART ? `${text.slice(0, SUMMARY_PART)}...` : text;
    return `${m.role === 'user' ? 'The person asked' : 'You answered'}: ${cut}`;
  });
  let summary = parts.join(' ');
  if (summary.length > SUMMARY_MAX) summary = `${summary.slice(0, SUMMARY_MAX - 3)}...`;
  return { messages: messages.slice(first), summary };
}
