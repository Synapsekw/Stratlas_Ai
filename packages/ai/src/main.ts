/**
 * Agent runtime for the Electron main process (Vercel AI SDK; Anthropic, OpenAI, Google). The
 * renderer sends `ai:send`; the runtime streams `ai:event`s back and, when the model calls a tool,
 * emits `tool-call` and waits for `ai:toolResult` from the renderer, which runs the tool (after the
 * person approves it for write and send risk). Keys come from the host and never leave this module.
 * Nothing here logs prompts, images or keys.
 */
import type { AiProvider, IpcEvent, IpcRequest, WindowKind } from '@aio/schema';
import {
  APICallError,
  RetryError,
  stepCountIs,
  streamText,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage,
  type Tool,
  type ToolSet,
  type UserContent,
} from 'ai';
import { estimateCostUsd } from './pricing';
import { contextBlock, systemPrompt } from './prompt';
import { createProviderRegistry, type ProviderRegistry } from './providers';
import { defaultRoutes, missingKeyMessage, routeFor, type ModelRoute } from './routes';
import { riskOf, toolsForWindow } from './tools';

export { createProviderRegistry, builtInProviders } from './providers';
export type { ModelProvider, ProviderRegistry } from './providers';

/** What the agent runtime needs from the Electron main process. */
export interface AgentRuntimeHost {
  /** API key from the OS vault, or null. Never logged, never sent to the renderer. */
  getKey(provider: AiProvider): Promise<string | null>;
  /** False when the person has cloud AI switched off: the runtime must refuse to call out. */
  cloudAllowed(): boolean;
  emit(event: IpcEvent<'ai:event'>): void;
  /** Model routes from Settings; defaults to defaultRoutes(). */
  routes?(): readonly ModelRoute[];
}

export interface AgentRuntime {
  send(req: IpcRequest<'ai:send'>): Promise<{ ok: boolean; error?: string }>;
  toolResult(req: IpcRequest<'ai:toolResult'>): void;
  cancel(runId: string): void;
}

export interface AgentRuntimeOptions {
  providers?: ProviderRegistry;
  /** Model calls per message (AI SDK steps). */
  maxSteps?: number;
  /** Retries on provider errors; 2 by default. */
  maxRetries?: number;
}

const MAX_STEPS = 8;

/** Fixed texts: errors never echo provider messages, which can contain request content. */
export const MESSAGES = {
  cloudOff: 'Cloud AI is off. Turn it on in Settings, AI providers, to use the agent.',
  busy: 'The agent is already working on this message.',
  noProvider: 'This AI provider is not available. Choose another in Settings, AI providers.',
  declined: 'The person declined this action. Do not try it again unless they ask.',
  stopped: 'Stopped.',
  stepLimit: `I stopped after ${MAX_STEPS} steps. Send another message to continue.`,
  failed: 'Something went wrong in the agent. Try again.',
  offline: (p: string) =>
    `Cannot reach ${p}. Check the internet connection, or keep working offline.`,
  keyRejected: (p: string) =>
    `${p} did not accept the API key. Check it in Settings, AI providers.`,
  rateLimited: (p: string) => `${p} is busy or rate limited. Wait a moment and try again.`,
  server: (p: string) => `${p} had a server error. Try again in a moment.`,
  badRequest: (p: string) =>
    `${p} could not handle this request. Start a new conversation or choose another model.`,
} as const;

type Outcome =
  { status: 'ok'; result: unknown } | { status: 'error'; message: string } | { status: 'declined' };

interface Run {
  controller: AbortController;
  pending: Map<string, (o: Outcome) => void>;
}

class Cancelled extends Error {}

export function createAgentRuntime(
  host: AgentRuntimeHost,
  options: AgentRuntimeOptions = {},
): AgentRuntime {
  const providers = options.providers ?? createProviderRegistry();
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const runs = new Map<string, Run>();

  function waitForRenderer(run: Run, callId: string): Promise<Outcome> {
    return new Promise<Outcome>((resolve, reject) => {
      const signal = run.controller.signal;
      if (signal.aborted) {
        reject(new Cancelled());
        return;
      }
      const onAbort = () => {
        run.pending.delete(callId);
        reject(new Cancelled());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      run.pending.set(callId, (o) => {
        signal.removeEventListener('abort', onAbort);
        run.pending.delete(callId);
        resolve(o);
      });
    });
  }

  function buildTools(runId: string, run: Run, window: WindowKind): ToolSet {
    const set: ToolSet = {};
    for (const spec of toolsForWindow(window)) {
      const name = spec.meta.name;
      const t: Tool<unknown, Outcome> = {
        description: spec.meta.description,
        inputSchema: spec.input,
        execute: (input, { toolCallId }) => {
          const outcome = waitForRenderer(run, toolCallId);
          host.emit({
            type: 'tool-call',
            runId,
            callId: toolCallId,
            name,
            input,
            risk: riskOf(name),
          });
          return outcome;
        },
        toModelOutput: ({ output }) => toModelOutput(output),
      };
      set[name] = t;
    }
    return set;
  }

  async function execute(req: IpcRequest<'ai:send'>, run: Run, route: ModelRoute, label: string) {
    const { runId } = req;
    const provider = providers.get(route.provider);
    if (!provider) throw new Error('unreachable: provider checked before start');
    const key = provider.needsKey ? await host.getKey(route.provider) : null;
    const model = provider.languageModel(route.model, key);
    let steps = 0;
    let lastFinish: string | undefined;
    try {
      const result = streamText({
        model,
        instructions: systemPrompt(req.window),
        messages: toModelMessages(req),
        tools: buildTools(runId, run, req.window),
        stopWhen: stepCountIs(maxSteps),
        abortSignal: run.controller.signal,
        maxRetries: options.maxRetries ?? 2,
        maxOutputTokens: 16_000,
      });
      for await (const part of result.stream) {
        if (run.controller.signal.aborted) throw new Cancelled();
        switch (part.type) {
          case 'text-delta':
            if (part.text) host.emit({ type: 'text', runId, delta: part.text });
            break;
          case 'finish-step':
            steps += 1;
            lastFinish = part.finishReason;
            host.emit(usageEvent(runId, route.model, part.usage));
            break;
          case 'error':
            throw part.error;
          case 'abort':
            throw new Cancelled();
          default:
            break;
        }
      }
      if (run.controller.signal.aborted) throw new Cancelled();
      if (steps >= maxSteps && lastFinish === 'tool-calls') {
        host.emit({ type: 'text', runId, delta: `\n\n${MESSAGES.stepLimit}` });
      }
      host.emit({ type: 'done', runId });
    } catch (e) {
      const message =
        e instanceof Cancelled || run.controller.signal.aborted
          ? MESSAGES.stopped
          : errorMessage(e, label);
      if (!(e instanceof Cancelled) && !run.controller.signal.aborted) {
        // Only the class and status: provider messages can quote the request.
        console.warn(`agent run failed: ${errorKind(e)}`);
      }
      host.emit({ type: 'error', runId, message });
    }
  }

  return {
    send: (req) => {
      if (runs.has(req.runId)) return Promise.resolve({ ok: false, error: MESSAGES.busy });
      let route: ModelRoute;
      try {
        route = routeFor(host.routes?.() ?? defaultRoutes(), req.image ? 'vision' : 'chat');
      } catch (e) {
        return Promise.resolve({
          ok: false,
          error: e instanceof Error ? e.message : MESSAGES.failed,
        });
      }
      const provider = providers.get(route.provider);
      if (!provider) return Promise.resolve({ ok: false, error: MESSAGES.noProvider });
      if (provider.cloud && !host.cloudAllowed()) {
        return Promise.resolve({ ok: false, error: MESSAGES.cloudOff });
      }
      const run: Run = { controller: new AbortController(), pending: new Map() };
      runs.set(req.runId, run);
      const start = async (): Promise<{ ok: boolean; error?: string }> => {
        if (provider.needsKey && !(await host.getKey(route.provider))) {
          runs.delete(req.runId);
          return { ok: false, error: missingKeyMessage(provider.label) };
        }
        void execute(req, run, route, provider.label).finally(() => {
          runs.delete(req.runId);
        });
        return { ok: true };
      };
      return start();
    },
    toolResult: (res) => {
      const resolve = runs.get(res.runId)?.pending.get(res.callId);
      if (!resolve) return;
      if (!res.approved) resolve({ status: 'declined' });
      else if (res.error !== undefined) resolve({ status: 'error', message: res.error });
      else resolve({ status: 'ok', result: res.result });
    },
    cancel: (runId) => {
      runs.get(runId)?.controller.abort();
    },
  };
}

function toModelMessages(req: IpcRequest<'ai:send'>): ModelMessage[] {
  let lastUser = -1;
  req.messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  const out: ModelMessage[] = req.messages.map((m, i) => {
    if (i !== lastUser) return { role: m.role, content: m.content };
    const content: UserContent = [
      { type: 'text', text: contextBlock(req.window, req.context) },
      { type: 'text', text: m.content },
    ];
    const img = req.image ? parseDataUrl(req.image) : null;
    if (img) content.push({ type: 'file', data: img.base64, mediaType: img.mediaType });
    return { role: 'user', content };
  });
  if (lastUser === -1) {
    out.push({ role: 'user', content: contextBlock(req.window, req.context) });
  }
  return out;
}

function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  return m?.[1] && m[2] ? { mediaType: m[1], base64: m[2] } : null;
}

type ModelOutput = Awaited<ReturnType<NonNullable<Tool<unknown, Outcome>['toModelOutput']>>>;

function toModelOutput(o: Outcome): ModelOutput {
  if (o.status === 'declined') return { type: 'execution-denied', reason: MESSAGES.declined };
  if (o.status === 'error') return { type: 'error-text', value: o.message };
  const image = imageOf(o.result);
  if (image) {
    return {
      type: 'content',
      value: [
        { type: 'text', text: image.caption },
        { type: 'file', data: { type: 'data', data: image.base64 }, mediaType: image.mediaType },
      ],
    };
  }
  if (o.result === undefined) return { type: 'text', value: 'Done.' };
  return { type: 'json', value: o.result as JSONValue };
}

/** Tool results carrying `{ image: 'data:image/...' }` (capture_frame) go to the model as images. */
function imageOf(result: unknown): { base64: string; mediaType: string; caption: string } | null {
  if (typeof result !== 'object' || result === null || !('image' in result)) return null;
  const { image, ...rest } = result as { image: unknown } & Record<string, unknown>;
  if (typeof image !== 'string') return null;
  const parsed = parseDataUrl(image);
  return parsed ? { ...parsed, caption: JSON.stringify(rest) } : null;
}

function usageEvent(runId: string, model: string, u: LanguageModelUsage): IpcEvent<'ai:event'> {
  const inputTokens = u.inputTokens ?? 0;
  const outputTokens = u.outputTokens ?? 0;
  const costUsd = estimateCostUsd(model, {
    inputTokens,
    outputTokens,
    cacheReadTokens: u.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWriteTokens: u.inputTokenDetails.cacheWriteTokens ?? 0,
  });
  return costUsd === undefined
    ? { type: 'usage', runId, inputTokens, outputTokens }
    : { type: 'usage', runId, inputTokens, outputTokens, costUsd };
}

function unwrap(e: unknown): unknown {
  return RetryError.isInstance(e) ? e.lastError : e;
}

function errorMessage(err: unknown, label: string): string {
  const e = unwrap(err);
  if (APICallError.isInstance(e)) {
    const s = e.statusCode;
    if (s === 401 || s === 403) return MESSAGES.keyRejected(label);
    if (s === 429 || s === 529) return MESSAGES.rateLimited(label);
    if (s !== undefined && s >= 500) return MESSAGES.server(label);
    if (s !== undefined && s >= 400) return MESSAGES.badRequest(label);
    return MESSAGES.offline(label);
  }
  if (isNetworkError(e)) return MESSAGES.offline(label);
  return MESSAGES.failed;
}

function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code =
    (e as { code?: unknown; cause?: { code?: unknown } }).code ??
    (e as { cause?: { code?: unknown } }).cause?.code;
  if (
    typeof code === 'string' &&
    /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR)/.test(code)
  )
    return true;
  return e instanceof TypeError && /fetch failed|network/i.test(e.message);
}

function errorKind(err: unknown): string {
  const e = unwrap(err);
  if (APICallError.isInstance(e)) return `APICallError ${e.statusCode ?? 'no status'}`;
  return e instanceof Error ? e.name : typeof e;
}
