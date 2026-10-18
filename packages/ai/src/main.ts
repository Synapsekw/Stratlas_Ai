/**
 * Agent runtime for the Electron main process (Vercel AI SDK; Anthropic, OpenAI, Google). The
 * renderer sends `ai:send`; the runtime streams `ai:event`s back and, when the model calls a tool,
 * emits `tool-call` and waits for `ai:toolResult` from the renderer, which runs the tool (after the
 * person approves it for write and send risk). Keys come from the host and never leave this module.
 * Nothing here logs prompts, images or keys. Provider errors are shown and logged with the
 * provider's own text, sanitised by `describeError` (keys removed, length capped).
 */
import {
  DETAIL_BUDGETS,
  type AiPolicy,
  type AiProvider,
  type AiTask,
  type AntennaAiLabel,
  type IpcEvent,
  type IpcRequest,
  type IpcResponse,
  type LocalModelSettings,
  type EngineerSetup,
  type WindowKind,
} from '@aio/schema';
import { createHash, randomUUID } from 'node:crypto';
import {
  antennaLabelInstructions,
  ANTENNA_LABEL_PROMPT_VERSION,
  antennaLabelOutputTokens,
  antennaLabelUserText,
  estimateAntennaLabel,
  parseAntennaLabels,
} from './antennaLabel';
import {
  buildEngineerPayload,
  ENGINEER_TIMEOUT_MS,
  EngineerSpendError,
  engineerCacheKey,
  engineerLimits,
  estimateEngineerCostUsd,
  fileEngineerCache,
  imageSize,
  runEngineer,
  TIME_USED_UP,
  type EngineerCall,
} from './engineer';
import { payloadPreview } from './engineerPrompt';
import {
  approvalScopeKey,
  readApproval,
  writeApproval,
  type RunApproval,
} from './engineerApproval';
import {
  committedRunSpend,
  readRunSpend,
  runLimits,
  writeRunSpend,
  type RunSpend,
} from './engineerSpend';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateText,
  RetryError,
  stepCountIs,
  streamText,
  type JSONValue,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type Tool,
  type ToolSet,
  type UserContent,
} from 'ai';
import { engineerReady } from './capabilities';
import {
  DEFAULT_BATCH,
  DETECT_PROMPT_VERSION,
  detectInstructions,
  detectUserText,
  parseDetectReply,
  planBatches,
  SEND_MAX_PX,
  sendSize,
} from './detect';
import {
  describeError,
  isNetworkError,
  OFFLINE_ONLY_MESSAGE,
  OfflineOnlyError,
  type DescribedError,
} from './errors';
import {
  COMPACT_MAX_STEPS,
  DEFAULT_LOCAL_TIMEOUT_MS,
  isToolsUnsupported,
  localGate,
  outputBudget,
  trimConversation,
} from './local';
import { estimateCostUsd } from './pricing';
import { contextBlock, summaryBlock, systemPrompt, type PromptProfile } from './prompt';
import {
  createProviderRegistry,
  localProvider,
  type ModelProvider,
  type ProviderRegistry,
} from './providers';
import { createToolCallRepair } from './repair';
import {
  defaultRoutes,
  missingKeyMessage,
  routeFor,
  serverRoot,
  TEST_MODELS,
  type ModelRoute,
} from './routes';
import { allToolSpecs, riskOf, toolsForWindow, type ToolProfile } from './tools';

export {
  BudgetReachedError,
  describeError,
  InvalidProposalError,
  OFFLINE_ONLY_MESSAGE,
  OfflineOnlyError,
  sanitize,
  type DescribedError,
} from './errors';
export {
  buildEngineerPayload,
  ENGINEER_MAX_OUTPUT_TOKENS,
  ENGINEER_TIMEOUT_MS,
  engineerCacheKey,
  engineerLimits,
  SUMMARY_MAX_CHARS,
  type EngineerPayload,
  type EngineerPayloadImage,
  estimateEngineerCostUsd,
  fileEngineerCache,
  imageSize,
  redactPaths,
  runEngineer,
  stripImageMetadata,
  type EngineerCall,
  type EngineerHost,
  type EngineerImage,
  type EngineerImageKind,
  type EngineerOutcome,
  type EngineerUsage,
} from './engineer';
export {
  anthropicHeaders,
  createProviderRegistry,
  builtInProviders,
  isLoopbackUrl,
  localProvider,
} from './providers';
export { createScriptedProvider } from './scripted';
export {
  discoverLocalModels,
  probeLocalModel,
  type DiscoverResult,
  type ProbeResult,
} from './local';
export { addProviderUsage, totalUsage, type ProviderUsageRow } from './pricing';

/** Every tool the agent can be offered; main checks that none of them approves (M9 decision 6). */
export const agentToolNames = (): string[] => allToolSpecs().map((s) => s.meta.name);
export type { BuiltInProviderOptions, ModelProvider, ProviderRegistry } from './providers';

/** What the agent runtime needs from the Electron main process. */
export interface AgentRuntimeHost {
  /** API key from the OS vault, or null. Never logged, never sent to the renderer. */
  getKey(provider: AiProvider): Promise<string | null>;
  /** False when the person has cloud AI switched off: the runtime must refuse to call out. */
  cloudAllowed(): boolean;
  /**
   * True while the workstation is offline-only: every cloud call is refused, whatever the cloud
   * switch says. A model on this machine (a loopback address) stays available.
   */
  offlineOnly?(): boolean;
  emit(event: IpcEvent<'ai:event'>): void;
  /** Model routes from Settings; defaults to defaultRoutes(). */
  routes?(): readonly ModelRoute[];
  /** The local model entry from Settings; the local provider exists only while it is enabled. */
  localModel?(): LocalModelSettings | undefined;
  /** The open project's AI policy (from its package manifest); `forbid` blocks cloud providers. */
  policy?(projectId: string): Promise<AiPolicy>;
  /** Called for every model step with tokens and the estimated cost, for the per-project meter. */
  recordUsage?(projectId: string, usage: StepUsage): void;
  /** The engineering model's AI step (`ai:engineerPreview`, `ai:engineer`); absent: refused. */
  engineer?: EngineerRuntimeHost;
  /** The telecom antenna labelling (`ai:antennaLabelPreview`, `ai:labelAntennas`); absent: refused. */
  telecom?: TelecomLabelHost;
}

/** What the antenna labelling needs from the Electron main process. */
export interface TelecomLabelHost {
  /**
   * The project's AI policy and photo consent, read from the manifest on disk now (never from the
   * renderer); null when the project is not open; `error` when the manifest cannot be read.
   */
  policy(projectId: string): Promise<{ ai: AiPolicy; photos: boolean } | { error: string } | null>;
  /** The crop image of each unit that has one (`telecom/crops/<id>.jpg`), with its SHA-256. */
  crops(
    projectId: string,
    unitIds: readonly string[],
  ): Promise<{ unitId: string; path: string; dataUrl: string; sha256: string }[]>;
  /** Downscale an image to `maxPx` on its long side (Electron `nativeImage`). */
  resize?(dataUrl: string, maxPx: number): Promise<string>;
}

/** What the engineer step needs from the Electron main process. */
export interface EngineerRuntimeHost {
  /**
   * The project's AI policy and its photo and scan consents, read from the manifest on disk now
   * (never from the renderer); null when the project is not open; `error` when the manifest
   * cannot be read (nothing is sent then).
   */
  policy(
    projectId: string,
  ): Promise<{ ai: AiPolicy; photos: boolean; scans: boolean } | { error: string } | null>;
  /**
   * The run's folder (`<project>/engineering/<run>`), undefined when the project has none (a
   * package, or not open). A request needs the run's `run.json` there; the cache and the run's
   * spend live in its `ai/` folder.
   */
  runDir?(projectId: string, engineerRun: string): string | undefined;
  /** Effective source transforms and on-disk input identity; no raw content leaves main. */
  sourceStamp?(projectId: string, setup: EngineerSetup): Promise<string>;
  /** Downscale an image to `maxPx` on its long side (Electron `nativeImage`). */
  resize?(dataUrl: string, maxPx: number): Promise<string>;
  /** The clock for the run's AI time; Date.now by default. */
  now?(): number;
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
  /**
   * One text completion on a task route without tools (the report narrative, BLD-7), behind the
   * same gates as the agent. Usage is metered to the project. Cancel with `cancel(runId)`.
   */
  draft(req: IpcRequest<'ai:draftText'>): Promise<IpcResponse<'ai:draftText'>>;
  /**
   * What the engineer step would send (the send preview), with the consents on disk, the cost
   * estimate and a one-time consent token for exactly this content. Sends nothing, reads no key.
   */
  engineerPreview(
    req: IpcRequest<'ai:engineerPreview'>,
  ): Promise<IpcResponse<'ai:engineerPreview'>>;
  /** One engineer request; `cancel(req.runId)` stops it. */
  engineer(req: IpcRequest<'ai:engineer'>): Promise<IpcResponse<'ai:engineer'>>;
  /** What an antenna labelling request would send, with a one-time token for exactly that. */
  antennaLabelPreview(
    req: IpcRequest<'ai:antennaLabelPreview'>,
  ): Promise<IpcResponse<'ai:antennaLabelPreview'>>;
  /** Label antenna crops with the vision route; AI sets no number. */
  labelAntennas(req: IpcRequest<'ai:labelAntennas'>): Promise<IpcResponse<'ai:labelAntennas'>>;
}

/** How long a one-time consent from the send preview stays valid. */
const CONSENT_MS = 10 * 60_000;

const NO_RUN =
  'This engineering run is not saved in the project, so its AI step cannot run. Start the run again from the engineering panel.';
const SPEND_UNREADABLE =
  "This run's AI spend record (engineering/<run>/ai/spend.json) could not be read, so no more AI requests are sent for it. Start a new run.";
const LIMIT_REACHED =
  'This run has made all the AI requests its detail level allows. Review the proposal so far, or start a new run.';
/** How long the one-time token of an antenna labelling preview stays valid. */
const LABEL_CONSENT_MS = 5 * 60_000;
const LABEL_PREVIEW_FIRST = 'Show the send preview first.';
const LABEL_NO_PHOTOS =
  'Photos of this project may not leave this computer. Allow them in the preview.';
const LABEL_NO_TELECOM = 'Antenna labelling is not available here.';
const LABEL_NO_CROPS =
  'None of these antennas has a photo crop to send. Run the antenna detection again.';

const PREVIEW_FIRST =
  'Open the send preview and send from there: every request to a cloud model is confirmed for exactly what it sends.';

export interface AgentRuntimeOptions {
  providers?: ProviderRegistry;
  /** Model calls per message (AI SDK steps). */
  maxSteps?: number;
  /** Retries on provider errors; 2 by default. */
  maxRetries?: number;
}

const MAX_STEPS = 8;

const stepLimitAfter = (n: number) =>
  `I stopped after ${String(n)} steps. Send another message to continue.`;

/** Fixed texts. Provider errors are described by `describeError` in errors.ts. */
export const MESSAGES = {
  answerOnly:
    "This local model cannot use the app's tools, so the agent answers in text only. Choose a model with tool calling in Settings, AI providers, to let it act.",
  answerOnlyNotice:
    "This local model cannot use the app's tools, so I can only answer in text. I cannot move the camera or change anything.",
  noVision:
    'The local model cannot read images. Choose a model with vision for Photo and frame vision in Settings, AI providers.',
  localDown: (root: string) =>
    `Cannot reach the local model server at ${root}. Start Ollama, LM Studio or the llama.cpp server, or check the address in Settings, AI providers.`,
  localTimeout: (ms: number) =>
    `The local model did not answer within ${String(Math.ceil(ms / 1000))} s. It may still be loading: try again, or allow more time in Settings, AI providers.`,
  cloudOff: 'Cloud AI is off. Turn it on in Settings, AI providers, to use the agent.',
  offlineOnly: OFFLINE_ONLY_MESSAGE,
  busy: 'The agent is already working on this message.',
  noProvider: 'This AI provider is not available. Choose another in Settings, AI providers.',
  forbidden:
    'This project does not allow sending its data to cloud AI. A local model set up in Settings, AI providers, can still be used.',
  localOff:
    'The local model is off. Turn it on in Settings, AI providers, or route the agent to a cloud provider.',
  declined: 'The person declined this action. Do not try it again unless they ask.',
  stopped: 'Stopped.',
  stepLimit: stepLimitAfter(MAX_STEPS),
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

/**
 * Silence watchdog for a local model: fires after `ms` without a stream part (the first token
 * included: a model may be loading), paused while a tool waits for the person.
 */
function idleWatchdog(ms: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = 0;
  let fired = false;
  const arm = () => {
    clearTimeout(timer);
    if (paused > 0) return;
    timer = setTimeout(() => {
      fired = true;
      controller.abort();
    }, ms);
  };
  arm();
  return {
    signal: controller.signal,
    fired: () => fired,
    kick: arm,
    pause: () => {
      paused += 1;
      clearTimeout(timer);
    },
    resume: () => {
      paused = Math.max(0, paused - 1);
      arm();
    },
    stop: () => {
      paused = Number.POSITIVE_INFINITY;
      clearTimeout(timer);
    },
  };
}

type Watchdog = ReturnType<typeof idleWatchdog>;

type Check =
  | { ok: true; route: ModelRoute; provider: ModelProvider; answerOnly?: boolean }
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
  const offlineOnly = () => host.offlineOnly?.() ?? false;

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

  function buildTools(
    runId: string,
    run: Run,
    window: WindowKind,
    profile: ToolProfile = 'full',
    watchdog?: Watchdog,
  ): ToolSet {
    const set: ToolSet = {};
    for (const spec of toolsForWindow(window, profile)) {
      const name = spec.meta.name;
      const t: Tool<unknown, Outcome> = {
        description: spec.meta.description,
        inputSchema: spec.input,
        execute: async (input, { toolCallId }) => {
          const outcome = waitForRenderer(run, toolCallId);
          host.emit({
            type: 'tool-call',
            runId,
            callId: toolCallId,
            name,
            input,
            risk: riskOf(name),
          });
          // The person may take their time to approve: that is not the model being slow.
          watchdog?.pause();
          try {
            return await outcome;
          } finally {
            watchdog?.resume();
          }
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
    return cfg?.enabled ? localProvider(cfg, { offlineOnly }) : undefined;
  }

  /**
   * Every gate before a call, in order: route, provider, offline-only, cloud switch, project
   * policy, key, then the engineer step's model capabilities and the local model probe.
   */
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
    // before the cloud switch: turning that on would not help while the workstation is offline-only
    if (cloud && offlineOnly()) {
      return { ok: false, reason: 'offline-only', message: MESSAGES.offlineOnly, route, cloud };
    }
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
    // The engineer step needs images in and a structured proposal out: known models only, unless
    // the person treats the model as a vision model; a local one by what the probe found.
    if (task === 'engineer') {
      const ready = engineerReady(route, localOf(route)?.capabilities);
      if (!ready.ok) return { ok: false, reason: 'no-route', message: ready.reason, route, cloud };
    }
    // A local route is checked against what the capability probe found (AI-9).
    if (route.provider === 'local') {
      const gate = localGate(host.localModel?.(), task);
      if (gate === 'no-vision') {
        return { ok: false, reason: 'no-route', message: MESSAGES.noVision, route, cloud };
      }
      if (gate === 'answer-only') return { ok: true, route, provider, answerOnly: true };
    }
    return { ok: true, route, provider };
  }

  /** The key a call uses: required for cloud providers, optional for a local server. Never logged. */
  async function keyFor(provider: ModelProvider, id: AiProvider): Promise<string | null> {
    return provider.needsKey || provider.optionalKey ? host.getKey(id) : null;
  }

  /** The local model settings when `route` runs on the local model. */
  function localOf(route: ModelRoute): LocalModelSettings | undefined {
    return route.provider === 'local' ? host.localModel?.() : undefined;
  }

  /** A provider failure for the person; a local server that is down gets its own message. */
  function describeFailure(
    e: unknown,
    provider: ModelProvider,
    route: ModelRoute,
    key: string | null,
  ): DescribedError {
    const described = describeError(e, {
      label: provider.label,
      model: route.model,
      secrets: [key],
    });
    const cause = RetryError.isInstance(e) ? e.lastError : e;
    if (route.provider === 'local' && isNetworkError(cause)) {
      const cfg = host.localModel?.();
      return {
        ...described,
        message: MESSAGES.localDown(cfg ? serverRoot(cfg.baseUrl) : 'the address'),
      };
    }
    return described;
  }

  async function execute(
    req: IpcRequest<'ai:send'>,
    run: Run,
    route: ModelRoute,
    provider: ModelProvider,
    answerOnlyAtStart: boolean,
  ) {
    const { runId } = req;
    const key = await keyFor(provider, route.provider);
    const model = provider.languageModel(route.model, key);
    const local = localOf(route);
    const watchdog = local ? idleWatchdog(local.timeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS) : undefined;
    const firstReply = !req.messages.some((m) => m.role === 'assistant');
    const progress = { steps: 0, lastFinish: undefined as string | undefined };
    let answerOnly = answerOnlyAtStart;
    try {
      for (;;) {
        try {
          if (answerOnly && firstReply) {
            host.emit({ type: 'text', runId, delta: `${MESSAGES.answerOnlyNotice}\n\n` });
          }
          await streamOnce(req, run, route, model, {
            local,
            cloud: provider.cloud,
            answerOnly,
            watchdog,
            progress,
          });
          break;
        } catch (e) {
          // A server that refuses tools before anything was said: answer in text only.
          if (local && !answerOnly && progress.steps === 0 && isToolsUnsupported(e)) {
            answerOnly = true;
            watchdog?.kick();
            continue;
          }
          throw e;
        }
      }
      if (run.controller.signal.aborted) throw new Cancelled();
      host.emit({ type: 'done', runId });
    } catch (e) {
      if (watchdog?.fired() && !run.controller.signal.aborted) {
        console.warn(`agent run timed out (${provider.label} ${route.model})`);
        host.emit({
          type: 'error',
          runId,
          message: MESSAGES.localTimeout(local?.timeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS),
        });
        return;
      }
      if (e instanceof Cancelled || run.controller.signal.aborted) {
        host.emit({ type: 'error', runId, message: MESSAGES.stopped });
        return;
      }
      const described = describeFailure(e, provider, route, key);
      console.warn(`agent run failed: ${described.log}`);
      host.emit({
        type: 'error',
        runId,
        message: described.message,
        ...(described.code ? { code: described.code } : {}),
      });
    } finally {
      watchdog?.stop();
    }
  }

  /** One streamed agent run (all its steps). Throws on provider errors and cancel. */
  async function streamOnce(
    req: IpcRequest<'ai:send'>,
    run: Run,
    route: ModelRoute,
    model: LanguageModel,
    o: {
      local: LocalModelSettings | undefined;
      /** The provider sends data off this machine. */
      cloud: boolean;
      answerOnly: boolean;
      watchdog: Watchdog | undefined;
      progress: { steps: number; lastFinish: string | undefined };
    },
  ): Promise<void> {
    const { runId } = req;
    const { local, watchdog, progress } = o;
    const toolProfile: ToolProfile = local?.toolProfile === 'compact' ? 'compact' : 'full';
    const limit = toolProfile === 'compact' ? Math.min(COMPACT_MAX_STEPS, maxSteps) : maxSteps;
    const promptProfile: PromptProfile = o.answerOnly
      ? 'answer-only'
      : toolProfile === 'compact'
        ? 'compact'
        : 'full';
    // Small context windows: the newest turns, the older ones as a short summary.
    const trimmed = local
      ? trimConversation(req.messages, local.contextTokens)
      : { messages: req.messages, summary: null };
    const instructions = trimmed.summary
      ? `${systemPrompt(req.window, promptProfile)}\n\n${summaryBlock(trimmed.summary)}`
      : systemPrompt(req.window, promptProfile);
    const signal = watchdog
      ? AbortSignal.any([run.controller.signal, watchdog.signal])
      : run.controller.signal;
    const tools = o.answerOnly
      ? undefined
      : buildTools(runId, run, req.window, toolProfile, watchdog);
    const result = streamText({
      model,
      instructions,
      messages: toModelMessages({ ...req, messages: trimmed.messages }),
      ...(tools ? { tools } : {}),
      stopWhen: stepCountIs(limit),
      // Offline-only turned on during the run (while an approval waited): no further step goes out.
      prepareStep: () => {
        if (o.cloud && offlineOnly()) throw new OfflineOnlyError();
        return {};
      },
      abortSignal: signal,
      maxRetries: options.maxRetries ?? 2,
      maxOutputTokens: local ? outputBudget(local.contextTokens) : 16_000,
      ...(local
        ? {
            // Small models: repair almost-JSON tool calls, and one call at a time.
            repairToolCall: createToolCallRepair({ model, abortSignal: signal }),
            ...(tools ? { providerOptions: { openai: { parallelToolCalls: false } } } : {}),
          }
        : {}),
      // Errors arrive as stream parts and are logged below, sanitised; the SDK default would
      // print the raw error to the console (and so to the log file).
      onError: () => undefined,
    });
    for await (const part of result.stream) {
      watchdog?.kick();
      if (run.controller.signal.aborted) throw new Cancelled();
      switch (part.type) {
        case 'text-delta':
          if (part.text) host.emit({ type: 'text', runId, delta: part.text });
          break;
        case 'finish-step':
          progress.steps += 1;
          progress.lastFinish = part.finishReason;
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
    if (progress.steps >= limit && progress.lastFinish === 'tool-calls') {
      host.emit({ type: 'text', runId, delta: `\n\n${stepLimitAfter(limit)}` });
    }
  }

  async function runDetect(
    req: IpcRequest<'ai:detect'>,
    run: Run,
    route: ModelRoute,
    provider: ModelProvider,
  ): Promise<IpcResponse<'ai:detect'>> {
    const key = await keyFor(provider, route.provider);
    const local = localOf(route);
    const timeoutMs = local
      ? Math.max(DETECT_TIMEOUT_MS, local.timeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS)
      : DETECT_TIMEOUT_MS;
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
        abortSignal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(timeoutMs)]),
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
      const described = describeFailure(e, provider, route, key);
      console.warn(`detection request failed: ${described.log}`);
      return {
        ok: false,
        error: described.message,
        ...(described.status !== undefined ? { status: described.status } : {}),
      };
    }
  }

  // ---------------------------------------------------------------- engineer step

  /** Engineering runs with a request out (one at a time per run); their spend is on disk. */
  const inFlight = new Set<string>();
  /** One-time consents handed out with a send preview: valid once, for that content only. */
  const consents = new Map<
    string,
    { projectId: string; run: string; key: string; expires: number; scope?: 'run' }
  >();
  const clock = () => host.engineer?.now?.() ?? Date.now();
  /** The registry the engineer step resolves through: the local model included. */
  const engineerProviders: ProviderRegistry = {
    get: resolveProvider,
    register: (p) => {
      providers.register(p);
    },
    list: () => providers.list(),
  };

  function engineerCallOf(req: IpcRequest<'ai:engineerPreview'>): EngineerCall {
    return {
      projectId: req.projectId,
      runId: req.engineerRun,
      pass: req.pass,
      images: req.images.map((im) => ({
        id: im.id,
        kind: im.kind,
        dataUrl: im.dataUrl,
        bytes: im.bytes,
        ...(im.view !== undefined ? { view: im.view } : {}),
      })),
      summary: req.summary,
      ...(req.observations ? { observations: req.observations } : {}),
      setup: req.setup,
      ...(req.previous ? { previous: req.previous } : {}),
    };
  }

  function engineerRoute(): ModelRoute | { error: string } {
    try {
      return routeFor(host.routes?.() ?? defaultRoutes(), 'engineer');
    } catch (e) {
      return { error: e instanceof Error ? e.message : MESSAGES.failed };
    }
  }

  /** What a consent token is bound to: the request content as the cache key sees it. */
  function contentKey(c: EngineerCall, route: ModelRoute): string {
    const local = localOf(route);
    return engineerCacheKey(c, route, engineerLimits(route, local?.capabilities), local?.baseUrl);
  }

  const notOpenMessage = 'The project is not open. Open it, then try again.';

  async function engineerPreview(
    req: IpcRequest<'ai:engineerPreview'>,
  ): Promise<IpcResponse<'ai:engineerPreview'>> {
    const eh = host.engineer;
    if (!eh) return { ok: false, error: 'The engineering step is not available here.' };
    const route = engineerRoute();
    if ('error' in route) return { ok: false, error: route.error };
    const ready = engineerReady(route, localOf(route)?.capabilities);
    if (!ready.ok) return { ok: false, error: ready.reason };
    const flags = await eh.policy(req.projectId);
    if (!flags) return { ok: false, error: notOpenMessage };
    if ('error' in flags) return { ok: false, error: flags.error };
    const c = engineerCallOf(req);
    const scope = req.approvalScope === 'run';
    const built = await buildEngineerPayload(
      c,
      scope ? { ...ready.caps, maxImages: 64 } : ready.caps,
      eh.resize?.bind(eh),
    );
    if (!built.ok) return { ok: false, error: built.reason };
    const provider = resolveProvider(route.provider);
    const estimate = estimateEngineerCostUsd(c, route, ready.caps);
    const now = clock();
    for (const [t, v] of consents) if (v.expires <= now) consents.delete(t);
    const token = randomUUID();
    consents.set(token, {
      projectId: req.projectId,
      run: req.engineerRun,
      key: scope
        ? approvalScopeKey(c, route, await eh.sourceStamp?.(req.projectId, req.setup))
        : contentKey(c, route),
      expires: now + CONSENT_MS,
      ...(scope ? { scope: 'run' as const } : {}),
    });
    return {
      ok: true,
      route: {
        task: route.task,
        provider: route.provider,
        model: route.model,
        ...(route.treatAsVision !== undefined ? { treatAsVision: route.treatAsVision } : {}),
      },
      cloud: provider ? provider.cloud : route.provider !== 'local',
      flags: { photos: flags.photos, scans: flags.scans },
      ...(estimate !== undefined ? { estimateUsd: estimate } : {}),
      content: payloadPreview(built.payload),
      consent: token,
    };
  }

  async function engineer(req: IpcRequest<'ai:engineer'>): Promise<IpcResponse<'ai:engineer'>> {
    const eh = host.engineer;
    if (!eh) {
      return {
        kind: 'refused',
        code: 'capability',
        reason: 'The engineering step is not available here.',
      };
    }
    if (runs.has(req.runId)) return { kind: 'refused', code: 'busy', reason: MESSAGES.busy };
    const runKey = `${req.projectId}\n${req.engineerRun}`;
    if (inFlight.has(runKey)) {
      return {
        kind: 'refused',
        code: 'busy',
        reason: 'Another AI request of this run is still under way. Wait for it, or stop it.',
      };
    }
    // Lock before any asynchronous preflight: every approved pass shares one spend ledger.
    inFlight.add(runKey);
    const run: Run = { controller: new AbortController(), pending: new Map() };
    runs.set(req.runId, run);
    try {
      const route = engineerRoute();
      if ('error' in route) return { kind: 'refused', code: 'capability', reason: route.error };
      const provider = resolveProvider(route.provider);
      const cloud = provider ? provider.cloud : route.provider !== 'local';
      if (cloud && offlineOnly()) {
        return { kind: 'refused', code: 'offline', reason: MESSAGES.offlineOnly };
      }
      if (cloud && !host.cloudAllowed()) {
        return { kind: 'refused', code: 'policy', reason: MESSAGES.cloudOff };
      }
      // an engineering run is saved in the project before its AI step: its allowance lives there
      const dir = eh.runDir?.(req.projectId, req.engineerRun);
      if (!dir || !existsSync(join(dir, 'run.json'))) {
        return { kind: 'refused', code: 'capability', reason: NO_RUN };
      }
      // the consents as the manifest on disk says now, whatever the renderer claims
      const disk = await eh.policy(req.projectId);
      if (!disk) return { kind: 'refused', code: 'policy', reason: notOpenMessage };
      if ('error' in disk) return { kind: 'refused', code: 'policy', reason: disk.error };
      let spend: RunSpend;
      try {
        // Refused and cached requests create no reservation or clock.
        spend = (await readRunSpend(dir)) ?? {
          startedAt: 0,
          spentUsd: 0,
          calls: 0,
          tokens: 0,
          unpriced: 0,
          aiMs: 0,
        };
      } catch {
        return { kind: 'refused', code: 'budget', reason: SPEND_UNREADABLE };
      }
      // The run has ten minutes of AI time per planned pass, shared across requests and retries.
      // Check the persisted allowance before spending a consent token; each call keeps its timeout.
      const priorReservedAiMs = spend.reservedAiMs ?? 0;
      const left =
        DETAIL_BUDGETS[req.setup.detail].passes * ENGINEER_TIMEOUT_MS -
        spend.aiMs -
        priorReservedAiMs;
      if (left <= 0) return { kind: 'refused', code: 'time', reason: TIME_USED_UP };
      const limits = runLimits(req.setup.detail, Boolean(req.observations?.length));
      const committed = committedRunSpend(spend);
      if (committed.calls >= limits.calls || committed.tokens >= limits.tokens) {
        return { kind: 'refused', code: 'budget', reason: LIMIT_REACHED };
      }
      const c: EngineerCall = {
        ...engineerCallOf(req),
        ...(req.costConfirmed ? { costConfirmed: true } : {}),
      };
      let { photos, scans } = disk;
      // every cloud request goes through the send preview: a token valid once, for this project
      // and exactly the content shown; the project consents only spare the per-request boxes
      const token = req.consent ? consents.get(req.consent.token) : undefined;
      if (req.consent) consents.delete(req.consent.token);
      const scopeKey =
        req.approvalScope === 'run'
          ? approvalScopeKey(c, route, await eh.sourceStamp?.(req.projectId, req.setup))
          : '';
      const valid =
        token?.projectId === req.projectId &&
        token.run === req.engineerRun &&
        token.expires > clock() &&
        token.key === (token.scope === 'run' ? scopeKey : contentKey(c, route));
      let grant: RunApproval | null = req.approvalScope === 'run' ? await readApproval(dir) : null;
      const generated = req.images.filter((i) => i.kind === 'generated');
      const generatedValid =
        generated.length <= 5 &&
        new Set(generated.map((i) => i.id)).size === generated.length &&
        generated.every((i) => /^gen-(north|east|south|west|top)$/.test(i.id));
      if (valid && token.scope === 'run' && req.consent) {
        grant = {
          token: req.consent.token,
          key: scopeKey,
          photos: photos || req.consent.photos,
          scans: scans || req.consent.scans,
          expires: clock() + 24 * 60 * 60 * 1000,
          budgetUsd: req.setup.budgetUsd ?? DETAIL_BUDGETS[req.setup.detail].costUsd,
          costConfirmed: req.costConfirmed === true,
        };
        try {
          await writeApproval(dir, grant);
        } catch {
          return {
            kind: 'refused',
            code: 'policy',
            reason: 'The run approval could not be saved. Nothing was sent.',
          };
        }
      }
      const runApproved =
        grant !== null &&
        grant.token === req.consent?.token &&
        grant.key === scopeKey &&
        grant.expires > clock() &&
        generatedValid;
      if (cloud && ((!valid && !runApproved) || (req.approvalScope === 'run' && !generatedValid)))
        return {
          kind: 'refused',
          code: 'policy',
          reason: PREVIEW_FIRST,
          ...(req.approvalScope === 'run' ? { approvalRequired: true } : {}),
        };
      if (runApproved && grant) {
        photos ||= grant.photos;
        scans ||= grant.scans;
        c.costConfirmed = grant.costConfirmed;
      }
      if (valid && req.consent) {
        photos ||= req.consent.photos;
        scans ||= req.consent.scans;
      }

      // the run's AI time is what its requests spend in flight, kept across restarts
      const sent: { began?: number } = {};
      const saveSpend = async (next: RunSpend) => {
        try {
          await writeRunSpend(dir, next);
        } catch {
          throw new EngineerSpendError();
        }
        spend = next;
      };
      let outcome: Awaited<ReturnType<typeof runEngineer>> | undefined;
      try {
        outcome = await runEngineer(c, {
          route: () => route,
          key: (p) => host.getKey(p as AiProvider),
          offlineOnly,
          policy: () => ({ ai: disk.ai, photos, scans }),
          authorize: async () => {
            if (!host.cloudAllowed()) return MESSAGES.cloudOff;
            const current = await eh.policy(req.projectId);
            if (
              !current ||
              'error' in current ||
              current.ai !== disk.ai ||
              current.photos !== disk.photos ||
              current.scans !== disk.scans
            )
              return 'Project sharing permission changed. Review the inputs again before continuing.';
            const currentRoute = engineerRoute();
            if ('error' in currentRoute || JSON.stringify(currentRoute) !== JSON.stringify(route))
              return 'The AI model changed. Review the inputs again before continuing.';
            if (
              req.approvalScope === 'run' &&
              approvalScopeKey(c, route, await eh.sourceStamp?.(req.projectId, req.setup)) !==
                scopeKey
            )
              return 'The source data changed. Review the inputs again before continuing.';
            return null;
          },
          cache: fileEngineerCache(join(dir, 'ai')),
          spent: () => committedRunSpend(spend).spentUsd,
          accounting: {
            reserve: async (reservation) => {
              await saveSpend({
                ...spend,
                startedAt: spend.startedAt || clock(),
                reservations: [...(spend.reservations ?? []), reservation],
                // One call's timeout covers all its tool steps and repair. Keep this debt
                // separate from money reservations, which may settle before time is saved.
                reservedAiMs: priorReservedAiMs + Math.min(ENGINEER_TIMEOUT_MS, left),
              });
            },
            release: async (id) => {
              await saveSpend({
                ...spend,
                reservations: spend.reservations?.filter((r) => r.id !== id),
                ...(sent.began === undefined ? { reservedAiMs: priorReservedAiMs } : {}),
              });
            },
            dispatched: () => {
              sent.began ??= clock();
            },
          },
          usage: async (u, reservationId) => {
            await saveSpend({
              ...spend,
              spentUsd: spend.spentUsd + (u.costUsd ?? 0),
              calls: spend.calls + 1,
              tokens: spend.tokens + u.inputTokens + u.outputTokens,
              unpriced: spend.unpriced + (u.costUsd === undefined ? 1 : 0),
              reservations: spend.reservations?.filter((r) => r.id !== reservationId),
            });
            const tags = { provider: u.provider, model: u.model };
            const cost = u.costUsd !== undefined ? { costUsd: u.costUsd } : {};
            host.emit({
              type: 'usage',
              runId: req.runId,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              ...cost,
              ...tags,
            });
            host.recordUsage?.(req.projectId, {
              ...tags,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              ...cost,
            });
          },
          budgetUsd:
            runApproved && grant
              ? grant.budgetUsd
              : (req.setup.budgetUsd ?? DETAIL_BUDGETS[req.setup.detail].costUsd),
          signal: run.controller.signal,
          providers: engineerProviders,
          localCaps: () => localOf(route)?.capabilities,
          endpoint: () => localOf(route)?.baseUrl,
          ...(eh.resize ? { resize: eh.resize.bind(eh) } : {}),
          maxRetries: options.maxRetries ?? 2,
          // Remaining whole-run time; runEngineer also enforces the per-call timeout.
          deadline: Date.now() + left,
          callsLeft: limits.calls - committed.calls,
          tokensLeft: limits.tokens - committed.tokens,
        });
      } finally {
        // Dispatch, rather than reported usage or outcome shape, charges time on every exit.
        if (sent.began !== undefined) {
          try {
            await saveSpend({
              ...spend,
              aiMs: spend.aiMs + Math.max(0, Math.round(clock() - sent.began)),
              // Replace only this call's debt atomically with its actual elapsed time.
              reservedAiMs: priorReservedAiMs,
            });
          } catch (e) {
            outcome = {
              kind: 'refused',
              code: 'budget',
              reason: (e as EngineerSpendError).message,
            };
          }
        }
      }
      return outcome.kind === 'refused' && outcome.code === 'policy' && req.approvalScope === 'run'
        ? { ...outcome, approvalRequired: true }
        : outcome;
    } finally {
      inFlight.delete(runKey);
      runs.delete(req.runId);
    }
  }

  // ---------------------------------------------------------------- antenna labelling

  /** One-time tokens of the antenna send preview: valid once, for these units, a few minutes. */
  const labelConsents = new Map<
    string,
    { projectId: string; ids: string; key: string; expires: number }
  >();
  const idsOf = (ids: readonly string[]) => [...new Set(ids)].sort().join('\n');

  /** The exact content of a request: the units, their crop files and the route. */
  function labelContentKey(
    crops: readonly { unitId: string; sha256: string }[],
    route: ModelRoute,
  ): string {
    const files = crops
      .map((c): [string, string] => [c.unitId, c.sha256])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return createHash('sha256')
      .update(JSON.stringify({ files, provider: route.provider, model: route.model }))
      .digest('hex');
  }

  /** The telecom host and the photo flag of the project, or the message to show instead. */
  async function labelProject(
    projectId: string,
    cloud: boolean,
  ): Promise<{ th: TelecomLabelHost; photos: boolean } | { error: string }> {
    const th = host.telecom;
    if (!th) return { error: LABEL_NO_TELECOM };
    const flags = await th.policy(projectId);
    if (!flags) return { error: notOpenMessage };
    if ('error' in flags) return { error: flags.error };
    if (cloud && flags.ai === 'forbid') return { error: MESSAGES.forbidden };
    return { th, photos: flags.photos };
  }

  async function antennaLabelPreview(
    req: IpcRequest<'ai:antennaLabelPreview'>,
  ): Promise<IpcResponse<'ai:antennaLabelPreview'>> {
    if (!host.telecom) return { ok: false, error: LABEL_NO_TELECOM };
    const gate = await check('vision', req.projectId);
    if (!gate.ok) return { ok: false, error: gate.message };
    const project = await labelProject(req.projectId, gate.provider.cloud);
    if ('error' in project) return { ok: false, error: project.error };
    const unitIds = [...new Set(req.unitIds)];
    const found = await project.th.crops(req.projectId, unitIds);
    const byId = new Map(found.map((c) => [c.unitId, c]));
    const crops = unitIds.flatMap((id) => byId.get(id) ?? []);
    if (crops.length === 0) return { ok: false, error: LABEL_NO_CROPS };
    const base = estimateAntennaLabel(crops.length);
    const batches = planBatches(crops, DEFAULT_BATCH).length;
    // every batch repeats the instructions
    const inputTokens =
      base.inputTokens + (batches - 1) * Math.ceil(antennaLabelInstructions().length / 4);
    const costUsd =
      gate.route.provider === 'local'
        ? 0
        : estimateCostUsd(gate.route.model, {
            inputTokens,
            outputTokens: antennaLabelOutputTokens(crops.length),
          });
    const now = Date.now();
    for (const [t, v] of labelConsents) if (v.expires <= now) labelConsents.delete(t);
    const token = randomUUID();
    labelConsents.set(token, {
      projectId: req.projectId,
      ids: idsOf(unitIds),
      key: labelContentKey(crops, gate.route),
      expires: now + LABEL_CONSENT_MS,
    });
    return {
      ok: true,
      provider: gate.route.provider,
      model: gate.route.model,
      cloud: gate.provider.cloud,
      photosAllowed: project.photos,
      crops: crops.map((c) => ({ unitId: c.unitId, path: c.path })),
      missing: unitIds.filter((id) => !byId.has(id)),
      estimate: {
        images: base.images,
        inputTokens,
        ...(costUsd !== undefined ? { costUsd } : {}),
      },
      token,
    };
  }

  async function labelAntennas(
    req: IpcRequest<'ai:labelAntennas'>,
  ): Promise<IpcResponse<'ai:labelAntennas'>> {
    if (runs.has(req.runId)) return { ok: false, error: MESSAGES.busy };
    const run: Run = { controller: new AbortController(), pending: new Map() };
    runs.set(req.runId, run);
    try {
      const gate = await check('vision', req.projectId);
      if (!gate.ok) return { ok: false, error: gate.message };
      const { route, provider } = gate;
      const cloud = provider.cloud;
      // every cloud request goes through the send preview: a token valid once, for this project
      // and exactly these units; it is spent whether or not it fits
      const token = req.token ? labelConsents.get(req.token) : undefined;
      if (req.token) labelConsents.delete(req.token);
      if (
        cloud &&
        !(
          token?.projectId === req.projectId &&
          token.expires > Date.now() &&
          token.ids === idsOf(req.unitIds)
        )
      ) {
        return { ok: false, error: LABEL_PREVIEW_FIRST };
      }
      const project = await labelProject(req.projectId, cloud);
      if ('error' in project) return { ok: false, error: project.error };
      if (cloud && !(project.photos || req.photos === true)) {
        return { ok: false, error: LABEL_NO_PHOTOS };
      }
      const unitIds = [...new Set(req.unitIds)];
      const found = await project.th.crops(req.projectId, unitIds);
      const byId = new Map(found.map((c) => [c.unitId, c]));
      const crops = unitIds.flatMap((id) => byId.get(id) ?? []);
      // the files must be the ones the preview showed
      if (cloud && token?.key !== labelContentKey(crops, route)) {
        return { ok: false, error: LABEL_PREVIEW_FIRST };
      }
      if (crops.length === 0) return { ok: false, error: LABEL_NO_CROPS };
      return await runAntennaLabels(req, run, route, provider, project.th, crops, unitIds.length);
    } finally {
      runs.delete(req.runId);
    }
  }

  async function runAntennaLabels(
    req: IpcRequest<'ai:labelAntennas'>,
    run: Run,
    route: ModelRoute,
    provider: ModelProvider,
    th: TelecomLabelHost,
    crops: readonly { unitId: string; dataUrl: string }[],
    asked: number,
  ): Promise<IpcResponse<'ai:labelAntennas'>> {
    const key = await keyFor(provider, route.provider);
    const local = localOf(route);
    const timeoutMs = local
      ? Math.max(DETECT_TIMEOUT_MS, local.timeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS)
      : DETECT_TIMEOUT_MS;
    const labels: { unitId: string; label: AntennaAiLabel; reason: string }[] = [];
    const warnings: string[] = [];
    if (crops.length < asked) {
      warnings.push(`${String(asked - crops.length)} units had no photo crop and were skipped.`);
    }
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd: number | undefined;
    // one record per run, also when a later batch fails: what was spent was spent
    const record = () => {
      if (inputTokens === 0 && outputTokens === 0) return;
      host.recordUsage?.(req.projectId, {
        provider: route.provider,
        model: route.model,
        inputTokens,
        outputTokens,
        ...(costUsd !== undefined ? { costUsd } : {}),
      });
    };
    try {
      for (const batch of planBatches(crops, DEFAULT_BATCH)) {
        if (run.controller.signal.aborted) {
          record();
          return { ok: false, error: MESSAGES.stopped };
        }
        const keys = batch.map((c) => c.unitId);
        const content: UserContent = [{ type: 'text', text: antennaLabelUserText(keys) }];
        for (const [i, c] of batch.entries()) {
          let img = parseDataUrl(c.dataUrl);
          const dim = img ? imageSize(Buffer.from(img.base64, 'base64')) : null;
          if (img && dim && th.resize) {
            const [w, h] = sendSize(dim.w, dim.h, SEND_MAX_PX);
            if (w !== dim.w || h !== dim.h) {
              img = parseDataUrl(await th.resize(c.dataUrl, SEND_MAX_PX));
            }
          }
          if (!img) {
            record();
            return { ok: false, error: `The crop of ${c.unitId} is not an image.` };
          }
          content.push({ type: 'text', text: `Image ${String(i + 1)}` });
          content.push({ type: 'file', data: img.base64, mediaType: img.mediaType });
        }
        const result = await generateText({
          model: provider.languageModel(route.model, key),
          instructions: antennaLabelInstructions(),
          messages: [{ role: 'user', content }],
          maxRetries: options.maxRetries ?? 2,
          maxOutputTokens: 2_000,
          abortSignal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(timeoutMs)]),
        });
        const u = usageEvent(req.runId, route, result.usage);
        if (u.type === 'usage') {
          inputTokens += u.inputTokens;
          outputTokens += u.outputTokens;
          if (u.costUsd !== undefined) costUsd = (costUsd ?? 0) + u.costUsd;
        }
        const parsed = parseAntennaLabels(result.text, keys);
        labels.push(...parsed.labels);
        warnings.push(...parsed.warnings);
      }
    } catch (e) {
      record();
      if (run.controller.signal.aborted) {
        return { ok: false, error: MESSAGES.stopped };
      }
      const described = describeFailure(e, provider, route, key);
      console.warn(`antenna label request failed: ${described.log}`);
      return { ok: false, error: described.message };
    }
    record();
    return {
      ok: true,
      provider: route.provider,
      model: route.model,
      promptVersion: ANTENNA_LABEL_PROMPT_VERSION,
      labels,
      inputTokens,
      outputTokens,
      ...(costUsd !== undefined ? { costUsd } : {}),
      warnings,
    };
  }

  return {
    engineerPreview,
    engineer,
    antennaLabelPreview,
    labelAntennas,
    send: async (req) => {
      if (runs.has(req.runId)) return { ok: false, error: MESSAGES.busy };
      const run: Run = { controller: new AbortController(), pending: new Map() };
      runs.set(req.runId, run);
      const gate = await check(req.task ?? (req.image ? 'vision' : 'chat'), req.projectId);
      if (!gate.ok) {
        runs.delete(req.runId);
        return { ok: false, error: gate.message };
      }
      void execute(req, run, gate.route, gate.provider, gate.answerOnly === true).finally(() => {
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
          // The agent can still answer, in text only: the panel shows why it cannot act.
          ...(gate.answerOnly
            ? { reason: 'answer-only' as const, message: MESSAGES.answerOnly }
            : {}),
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
      if (provider.cloud && offlineOnly()) return { ok: false, message: MESSAGES.offlineOnly };
      if (provider.cloud && !host.cloudAllowed()) return { ok: false, message: MESSAGES.cloudOff };
      const routes = host.routes?.() ?? defaultRoutes();
      const routed =
        routes.find((r) => r.provider === id && r.task === 'chat') ??
        routes.find((r) => r.provider === id);
      const model =
        routed?.model ?? (id === 'local' ? host.localModel?.()?.model : TEST_MODELS[id]);
      if (!model) return { ok: false, message: MESSAGES.noTestModel };
      const key = await keyFor(provider, id);
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
          ...(described.code ? { code: described.code } : {}),
        };
      }
    },
    draft: async (req) => {
      if (runs.has(req.runId)) return { ok: false, error: MESSAGES.busy };
      const run: Run = { controller: new AbortController(), pending: new Map() };
      runs.set(req.runId, run);
      try {
        const gate = await check(req.task, req.projectId);
        if (!gate.ok) return { ok: false, error: gate.message };
        const { route, provider } = gate;
        const key = await keyFor(provider, route.provider);
        try {
          const result = await generateText({
            model: provider.languageModel(route.model, key),
            instructions: req.system,
            prompt: req.prompt,
            maxOutputTokens: 8_000,
            maxRetries: options.maxRetries ?? 2,
            abortSignal: run.controller.signal,
          });
          const event = usageEvent(req.runId, route, result.usage);
          if (event.type === 'usage') {
            host.recordUsage?.(req.projectId, {
              provider: route.provider,
              model: route.model,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
            });
          }
          return { ok: true, text: result.text, provider: route.provider, model: route.model };
        } catch (e) {
          if (run.controller.signal.aborted) return { ok: false, error: MESSAGES.stopped };
          const described = describeFailure(e, provider, route, key);
          console.warn(`draft failed: ${described.log}`);
          return { ok: false, error: described.message };
        }
      } finally {
        runs.delete(req.runId);
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
