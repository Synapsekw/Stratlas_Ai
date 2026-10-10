/**
 * Provider layer (AI-9). A provider turns a model id and an optional key into an AI SDK language
 * model. The three cloud providers are built in. The local provider talks to an OpenAI-compatible
 * server on this machine (for example Ollama); it is `cloud: false, needsKey: false` and so allowed
 * with cloud AI off, but only while its address is a loopback address. Main process only: this
 * module pulls in the provider SDKs.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LocalModelSettings } from '@aio/schema';
import type { LanguageModel } from 'ai';
import { OfflineOnlyError } from './errors';
import { isLoopbackUrl, openAiBase, PROVIDER_LABELS } from './routes';

export { isLoopbackUrl };

export interface ModelProvider {
  /** Matches the `provider` of a model route. */
  id: string;
  label: string;
  /** Sends data off the machine: refused while cloud AI is off. */
  cloud: boolean;
  needsKey: boolean;
  /**
   * A key is used when the vault has one, but none is needed (a local server that wants a bearer
   * key: LM Studio, a secured llama.cpp server).
   */
  optionalKey?: boolean;
  /** Build the model. `key` is null only when `needsKey` is false. Never log the key. */
  languageModel(modelId: string, key: string | null): LanguageModel;
}

export interface ProviderRegistry {
  get(id: string): ModelProvider | undefined;
  register(provider: ModelProvider): void;
  list(): ModelProvider[];
}

export interface BuiltInProviderOptions {
  /**
   * Anthropic workspace for keys that are not scoped to one (organisation keys): sent as the
   * `anthropic-workspace-id` header. Read on every request so a change in Settings applies at once.
   */
  anthropicWorkspaceId?: () => string | undefined;
  /** Replaces the network for tests. */
  fetch?: typeof globalThis.fetch;
  /**
   * True while the workstation is offline-only. Read on every request: a cloud request is then
   * refused before it leaves, whatever started it (a run under way when the switch was turned on).
   */
  offlineOnly?: () => boolean;
}

/** The `fetch` of a cloud provider: every request is refused while the workstation is offline-only. */
function cloudFetch(options: BuiltInProviderOptions): { fetch?: typeof globalThis.fetch } {
  const { offlineOnly } = options;
  if (!offlineOnly) return options.fetch ? { fetch: options.fetch } : {};
  return {
    fetch: (input, init) =>
      offlineOnly()
        ? Promise.reject(new OfflineOnlyError())
        : (options.fetch ?? globalThis.fetch)(input, init),
  };
}

/** The `anthropic-workspace-id` header, or nothing when no workspace is set. */
export function anthropicHeaders(workspaceId: string | undefined): Record<string, string> {
  const id = workspaceId?.trim();
  return id ? { 'anthropic-workspace-id': id } : {};
}

export function builtInProviders(options: BuiltInProviderOptions = {}): ModelProvider[] {
  const fetch = cloudFetch(options);
  return [
    {
      id: 'anthropic',
      label: PROVIDER_LABELS.anthropic,
      cloud: true,
      needsKey: true,
      languageModel: (model, key) =>
        createAnthropic({
          apiKey: key ?? '',
          headers: anthropicHeaders(options.anthropicWorkspaceId?.()),
          ...fetch,
        })(model),
    },
    {
      id: 'openai',
      label: PROVIDER_LABELS.openai,
      cloud: true,
      needsKey: true,
      languageModel: (model, key) => createOpenAI({ apiKey: key ?? '', ...fetch })(model),
    },
    {
      id: 'google',
      label: PROVIDER_LABELS.google,
      cloud: true,
      needsKey: true,
      languageModel: (model, key) => createGoogle({ apiKey: key ?? '', ...fetch })(model),
    },
  ];
}

/**
 * The local model from Settings. An address on another machine sends data off this one, so it is
 * then treated as a cloud provider (refused while cloud AI is off, the project forbids it or the
 * workstation is offline-only). A server on this machine is never held back by offline-only.
 */
export function localProvider(
  cfg: Pick<LocalModelSettings, 'baseUrl'>,
  options: Pick<BuiltInProviderOptions, 'fetch' | 'offlineOnly'> = {},
): ModelProvider {
  const cloud = !isLoopbackUrl(cfg.baseUrl);
  const fetch = cloud ? cloudFetch(options) : options.fetch ? { fetch: options.fetch } : {};
  return {
    id: 'local',
    label: PROVIDER_LABELS.local,
    cloud,
    needsKey: false,
    optionalKey: true,
    // OpenAI-compatible chat completions: Ollama, LM Studio and the llama.cpp server all serve them.
    languageModel: (model, key) =>
      createOpenAI({
        baseURL: openAiBase(cfg.baseUrl),
        apiKey: key ?? 'local',
        name: 'local',
        ...fetch,
      }).chat(model),
  };
}
export function createProviderRegistry(
  initial: readonly ModelProvider[] = builtInProviders(),
): ProviderRegistry {
  const map = new Map<string, ModelProvider>();
  const registry: ProviderRegistry = {
    get: (id) => map.get(id),
    register: (p) => {
      map.set(p.id, p);
    },
    list: () => [...map.values()],
  };
  for (const p of initial) registry.register(p);
  return registry;
}
