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
import { PROVIDER_LABELS } from './routes';

export interface ModelProvider {
  /** Matches the `provider` of a model route. */
  id: string;
  label: string;
  /** Sends data off the machine: refused while cloud AI is off. */
  cloud: boolean;
  needsKey: boolean;
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
}

/** The `anthropic-workspace-id` header, or nothing when no workspace is set. */
export function anthropicHeaders(workspaceId: string | undefined): Record<string, string> {
  const id = workspaceId?.trim();
  return id ? { 'anthropic-workspace-id': id } : {};
}

export function builtInProviders(options: BuiltInProviderOptions = {}): ModelProvider[] {
  const fetch = options.fetch ? { fetch: options.fetch } : {};
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

/** True for localhost, 127.0.0.0/8 and ::1: requests to these never leave the machine. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The local model from Settings. An address on another machine sends data off this one, so it is
 * then treated as a cloud provider (refused while cloud AI is off or the project forbids it).
 */
export function localProvider(cfg: Pick<LocalModelSettings, 'baseUrl'>): ModelProvider {
  return {
    id: 'local',
    label: PROVIDER_LABELS.local,
    cloud: !isLoopbackUrl(cfg.baseUrl),
    needsKey: false,
    languageModel: (model) =>
      createOpenAI({ baseURL: cfg.baseUrl, apiKey: 'local', name: 'local' }).chat(model),
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
