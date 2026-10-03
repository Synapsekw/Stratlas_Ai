/**
 * Provider layer (AI-9). A provider turns a model id and an optional key into an AI SDK language
 * model. The three cloud providers are built in; a local provider (for example Ollama) can be
 * registered later with `cloud: false, needsKey: false` and is then allowed with cloud AI off.
 * Main process only: this module pulls in the provider SDKs.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { PROVIDER_LABELS } from './routing';

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

export function builtInProviders(): ModelProvider[] {
  return [
    {
      id: 'anthropic',
      label: PROVIDER_LABELS.anthropic,
      cloud: true,
      needsKey: true,
      languageModel: (model, key) => createAnthropic({ apiKey: key ?? '' })(model),
    },
    {
      id: 'openai',
      label: PROVIDER_LABELS.openai,
      cloud: true,
      needsKey: true,
      languageModel: (model, key) => createOpenAI({ apiKey: key ?? '' })(model),
    },
    {
      id: 'google',
      label: PROVIDER_LABELS.google,
      cloud: true,
      needsKey: true,
      languageModel: (model, key) => createGoogle({ apiKey: key ?? '' })(model),
    },
  ];
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
