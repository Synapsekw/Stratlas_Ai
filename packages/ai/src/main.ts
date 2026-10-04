/**
 * Agent runtime for the Electron main process (Vercel AI SDK; Anthropic, OpenAI, Google). The
 * renderer sends `ai:send`; the runtime streams `ai:event`s back and, when the model calls a tool,
 * emits `tool-call` and waits for `ai:toolResult` from the renderer, which runs the tool (after the
 * person approves it for write and send risk). Keys come from the host and never leave this module.
 * Nothing here logs prompts, images or keys. Provider errors are shown and logged with the
 * provider's own text, sanitised by `describeError` (keys removed, length capped).
 */
import type {
  AiPolicy,
  AiProvider,
  AiTask,
  IpcEvent,
  IpcRequest,
  IpcResponse,
  LocalModelSettings,
  WindowKind,
} from '@aio/schema';
import {
  generateText,
  stepCountIs,
  streamText,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage,
  type Tool,
  type ToolSet,
  type UserContent,
} from 'ai';
import {
  DETECT_PROMPT_VERSION,
  detectInstructions,
  detectUserText,
  parseDetectReply,
} from './detect';
import { describeError } from './errors';
import { estimateCostUsd } from './pricing';
import { contextBlock, systemPrompt } from './prompt';
import {
  createProviderRegistry,
  localProvider,
  type ModelProvider,
  type ProviderRegistry,
} from './providers';
import { defaultRoutes, missingKeyMessage, routeFor, TEST_MODELS, type ModelRoute } from './routes';
import { riskOf, toolsForWindow } from './tools';

export { describeError, sanitize, type DescribedError } from './errors';
export {
  anthropicHeaders,
  createProviderRegistry,
  builtInProviders,
  isLoopbackUrl,
  localProvider,
} from './providers';
export { createScriptedProvider } from './scripted';
export { addProviderUsage, totalUsage, type ProviderUsageRow } from './pricing';
export type { BuiltInProviderOptions, ModelProvider, ProviderRegistry } from './providers';

/** What the agent runtime needs from the Electron main process. */
export interface AgentRuntimeHost {
  /** API key from the OS vault, or null. Never logged, never sent to the renderer. */
  getKey(provider: AiProvider): Promise<string | null>;
  /** False when the person has cloud AI switched off: the runtime must refuse to call out. */
  cloudAllowed(): boolean;
  emit(event: IpcEvent<'ai:event'>): void;
  /** Model routes from Settings; defaults to defaultRoutes(). */
  routes?(): readonly ModelRoute[];
  /** The local model entry from Settings; the local provider exists only while it is enabled. */
  localModel?(): LocalModelSettings | undefined;
  /** The open project's AI policy (from its package manifest); `forbid` blocks cloud providers. */
  policy?(projectId: string): Promise<AiPolicy>;
  /** Called for every model step with tokens and the estimated cost, for the per-project meter. */
  recordUsage?(projectId: string, usage: StepUsage): void;
}

export interface StepUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface AgentRuntime {
  send(req: IpcRequest<'ai:send'>): Promise<{ ok: boolean; error?: string }>;
  toolResult(req: IpcRequest<'ai:toolResult'>): void;
  cancel(runId: string): void;
  /** Whether the chat route can answer now, and why not. Never calls a provider. */
  status(req: IpcRequest<'ai:status'>): Promise<IpcResponse<'ai:status'>>;
  /**
   * One minimal request to a provider (Settings, Test connection), with the model its routes use.
   * Only on the person's click: it calls out when cloud AI is on.
   */
  testConnection(req: IpcRequest<'ai:testConnection'>): Promise<IpcResponse<'ai:testConnection'>>;
  /**
   * AI-assisted detection (BLD-6): one batch of images to the vision route, through the same
   * gates as the agent. `cancel(runId)` stops it. Never retried silently past `maxRetries`.
   */
  detect(req: IpcRequest<'ai:detect'>): Promise<IpcResponse<'ai:detect'>>;
}

export interface AgentRuntimeOptions {
  providers?: ProviderRegistry;
  /** Model calls per message (AI SDK steps). */
  maxSteps?: number;
  /** Retries on provider errors; 2 by default. */
  maxRetries?: number;
}

const MAX_STEPS = 8;

/** Fixed texts. Provider errors are described by `describeError` in errors.ts. */
export const MESSAGES = {
  cloudOff: 'Cloud AI is off. Turn it on in Settings, AI providers, to use the agent.',
  busy: 'The agent is already working on this message.',
  noProvider: 'This AI provider is not available. Choose another in Settings, AI providers.',
  forbidden:
    'This project does not allow sending its data to cloud AI. A local model set up in Settings, AI providers, can still be used.',
  localOff:
    'The local model is off. Turn it on in Settings, AI providers, or route the agent to a cloud provider.',
  declined: 'The person declined this action. Do not try it again unless they ask.',
  stopped: 'Stopped.',
  stepLimit: `I stopped after ${MAX_STEPS} steps. Send another message to continue.`,
  failed: 'Something went wrong in the agent. Try again.',
  noTestModel: 'No model is set for this provider. Choose one in Settings, AI providers.',
} as const;

/** The connection test asks for a one-word answer: a few tokens in and out. */
const TEST_PROMPT = 'Reply with the single word OK.';
const TEST_TIMEOUT_MS = 30_000;
/** One detection batch (up to 8 large images) may take a while on a busy provider. */
const DETECT_TIMEOUT_MS = 180_000;

type Outcome =
  { status: 'ok'; result: unknown } | { status: 'error'; message: string } | { status: 'declined' };

interface Run {
  controller: AbortController;
  pending: Map<string, (o: Outcome) => void>;
}

class Cancelled extends Error {}

type Check =
  | { ok: true; route: ModelRoute; provider: ModelProvider }
  | {
      ok: false;
      reason: NonNullable<IpcResponse<'ai:status'>['reason']>;
      message: string;
      route?: ModelRoute;
      cloud: boolean;
    };

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

  function resolveProvider(id: string): ModelProvider | undefined {
    const registered = providers.get(id);
    if (registered) return registered;
    if (id !== 'local') return undefined;
    const cfg = host.localModel?.();
    return cfg?.enabled ? localProvider(cfg) : undefined;
  }

  /** Every gate before a call, in order: route, provider, cloud switch, project policy, key. */
  async function check(task: AiTask, projectId: string | undefined): Promise<Check> {
    let route: ModelRoute;
    try {
      route = routeFor(host.routes?.() ?? defaultRoutes(), task);
    } catch (e) {
      return {
        ok: false,
        reason: 'no-route',
        message: e instanceof Error ? e.message : MESSAGES.failed,
        cloud: true,
      };
    }
    const provider = resolveProvider(route.provider);
    if (!provider) {
      return route.provider === 'local'
        ? { ok: false, reason: 'local-off', message: MESSAGES.localOff, route, cloud: false }
        : { ok: false, reason: 'no-provider', message: MESSAGES.noProvider, route, cloud: true };
    }
    const cloud = provider.cloud;
    if (cloud && !host.cloudAllowed()) {
      return { ok: false, reason: 'cloud-off', message: MESSAGES.cloudOff, route, cloud };
    }
    if (cloud && projectId && host.policy && (await host.policy(projectId)) === 'forbid') {
      return { ok: false, reason: 'forbidden', message: MESSAGES.forbidden, route, cloud };
    }
    if (provider.needsKey && !(await host.getKey(route.provider))) {
      return {
        ok: false,
        reason: 'no-key',
        message: missingKeyMessage(provider.label),
        route,
        cloud,
      };
    }
    return { ok: true, route, provider };
  }

  async function execute(
    req: IpcRequest<'ai:send'>,
    run: Run,
    route: ModelRoute,
    provider: ModelProvider,
  ) {
    const { runId } = req;
    const label = provider.label;
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
        // Errors arrive as stream parts and are logged below, sanitised; the SDK default would
        // print the raw error to the console (and so to the log file).
        onError: () => undefined,
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
            {
              const event = usageEvent(runId, route, part.usage);
              host.emit(event);
              if (req.projectId && event.type === 'usage') {
                host.recordUsage?.(req.projectId, {
                  provider: route.provider,
                  model: route.model,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
                });
              }
            }
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
      if (e instanceof Cancelled || run.controller.signal.aborted) {
        host.emit({ type: 'error', runId, message: MESSAGES.stopped });
        return;
      }
      const described = describeError(e, { label, model: route.model, secrets: [key] });
      console.warn(`agent run failed: ${described.log}`);
      host.emit({ type: 'error', runId, message: described.message });
    }
  }

  async function runDetect(
    req: IpcRequest<'ai:detect'>,
    run: Run,
    route: ModelRoute,
    provider: ModelProvider,
  ): Promise<IpcResponse<'ai:detect'>> {
    const key = provider.needsKey ? await host.getKey(route.provider) : null;
    const prompt = { classes: req.classes, severity: req.severity, hint: req.hint };
    const content: UserContent = [
      { type: 'text', text: detectUserText(req.images.length, req.hint) },
    ];
    for (const [i, im] of req.images.entries()) {
      const img = parseDataUrl(im.dataUrl);
      if (!img) return { ok: false, error: `Image ${String(i + 1)} is not an image data URL.` };
      content.push({ type: 'text', text: `Image ${String(i + 1)}` });
      content.push({ type: 'file', data: img.base64, mediaType: img.mediaType });
    }
    try {
      const result = await generateText({
        model: provider.languageModel(route.model, key),
        instructions: detectInstructions(prompt),
        messages: [{ role: 'user', content }],
        maxRetries: options.maxRetries ?? 2,
        maxOutputTokens: 8_000,
        abortSignal: AbortSignal.any([
          run.controller.signal,
          AbortSignal.timeout(DETECT_TIMEOUT_MS),
        ]),
      });
      const u = usageEvent(req.runId, route, result.usage);
      const usage = u.type === 'usage' ? u : null;
      if (usage) {
        host.recordUsage?.(req.projectId, {
          provider: route.provider,
          model: route.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        });
      }
      const parsed = parseDetectReply(result.text, req.images.length, req.classes);
      if (typeof parsed === 'string') {
        console.warn(`detection reply unreadable (${provider.label} ${route.model})`);
        return { ok: false, error: `${provider.label}, ${route.model}: ${parsed}` };
      }
      return {
        ok: true,
        provider: route.provider,
        model: route.model,
        promptVersion: DETECT_PROMPT_VERSION,
        results: req.images.map((im, i) => ({ key: im.key, detections: parsed.results[i] ?? [] })),
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        warnings: parsed.warnings,
      };
    } catch (e) {
      if (run.controller.signal.aborted)
        return { ok: false, error: MESSAGES.stopped, stopped: true };
      const described = describeError(e, {
        label: provider.label,
        model: route.model,
        secrets: [key],
      });
      console.warn(`detection request failed: ${described.log}`);
      return {
        ok: false,
        error: described.message,
        ...(described.status !== undefined ? { status: described.status } : {}),
      };
    }
  }

  return {
    send: async (req) => {
      if (runs.has(req.runId)) return { ok: false, error: MESSAGES.busy };
      const run: Run = { controller: new AbortController(), pending: new Map() };
      runs.set(req.runId, run);
      const gate = await check(req.image ? 'vision' : 'chat', req.projectId);
      if (!gate.ok) {
        runs.delete(req.runId);
        return { ok: false, error: gate.message };
      }
      void execute(req, run, gate.route, gate.provider).finally(() => {
        runs.delete(req.runId);
      });
      return { ok: true };
    },
    detect: async (req) => {
      if (runs.has(req.runId)) return { ok: false, error: MESSAGES.busy };
      const run: Run = { controller: new AbortController(), pending: new Map() };
      runs.set(req.runId, run);
      try {
        const gate = await check('vision', req.projectId);
        if (!gate.ok) return { ok: false, error: gate.message };
        return await runDetect(req, run, gate.route, gate.provider);
      } finally {
        runs.delete(req.runId);
      }
    },
    status: async (req) => {
      const gate = await check(req.task ?? 'chat', req.projectId);
      if (gate.ok) {
        return {
          ready: true,
          route: { task: gate.route.task, provider: gate.route.provider, model: gate.route.model },
          cloud: gate.provider.cloud,
        };
      }
      return {
        ready: false,
        reason: gate.reason,
        message: gate.message,
        ...(gate.route
          ? {
              route: {
                task: gate.route.task,
                provider: gate.route.provider,
                model: gate.route.model,
              },
            }
          : {}),
        cloud: gate.cloud,
      };
    },
    testConnection: async ({ provider: id }) => {
      const provider = resolveProvider(id);
      if (!provider) {
        return { ok: false, message: id === 'local' ? MESSAGES.localOff : MESSAGES.noProvider };
      }
      if (provider.cloud && !host.cloudAllowed()) return { ok: false, message: MESSAGES.cloudOff };
      const routes = host.routes?.() ?? defaultRoutes();
      const routed =
        routes.find((r) => r.provider === id && r.task === 'chat') ??
        routes.find((r) => r.provider === id);
      const model =
        routed?.model ?? (id === 'local' ? host.localModel?.()?.model : TEST_MODELS[id]);
      if (!model) return { ok: false, message: MESSAGES.noTestModel };
      const key = provider.needsKey ? await host.getKey(id) : null;
      if (provider.needsKey && !key) {
        return { ok: false, message: missingKeyMessage(provider.label), model };
      }
      try {
        const result = await generateText({
          model: provider.languageModel(model, key),
          prompt: TEST_PROMPT,
          maxOutputTokens: 256,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
        const reply = result.text.trim().slice(0, 40);
        return {
          ok: true,
          message: `${provider.label} answered with ${model}${reply ? `: "${reply}"` : ''}.`,
          model,
        };
      } catch (e) {
        const described = describeError(e, { label: provider.label, model, secrets: [key] });
        console.warn(`connection test failed: ${described.log}`);
        return {
          ok: false,
          message: described.message,
          model,
          ...(described.status !== undefined ? { status: described.status } : {}),
        };
      }
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

function usageEvent(runId: string, route: ModelRoute, u: LanguageModelUsage): IpcEvent<'ai:event'> {
  const inputTokens = u.inputTokens ?? 0;
  const outputTokens = u.outputTokens ?? 0;
  const tags = { provider: route.provider, model: route.model };
  // A local model runs on this machine: no per-token cost.
  if (route.provider === 'local') {
    return { type: 'usage', runId, inputTokens, outputTokens, costUsd: 0, ...tags };
  }
  const costUsd = estimateCostUsd(route.model, {
    inputTokens,
    outputTokens,
    cacheReadTokens: u.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWriteTokens: u.inputTokenDetails.cacheWriteTokens ?? 0,
  });
  return costUsd === undefined
    ? { type: 'usage', runId, inputTokens, outputTokens, ...tags }
    : { type: 'usage', runId, inputTokens, outputTokens, costUsd, ...tags };
}
