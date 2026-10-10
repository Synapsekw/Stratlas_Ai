import type { AiProvider, AiTask } from '@aio/schema';

/** Cloud providers that take an API key. */
export const PROVIDERS = ['anthropic', 'openai', 'google'] as const satisfies readonly AiProvider[];

/** Every provider a route can use: the cloud ones and a local model on this machine. */
export const ROUTE_PROVIDERS = [...PROVIDERS, 'local'] as const satisfies readonly AiProvider[];

/** Defaults for the local model entry in Settings (Ollama's OpenAI-compatible endpoint). */
export const DEFAULT_LOCAL_MODEL = {
  enabled: false,
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3.2-vision',
} as const;

/**
 * The person's own model servers, on their default ports on this machine (decision 1: nothing is
 * bundled). Find models tries the typed address first, then these.
 */
export const LOCAL_SERVERS = [
  { kind: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { kind: 'openai-compatible', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { kind: 'openai-compatible', label: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1' },
] as const;

/**
 * True for localhost, 127.0.0.0/8 and ::1: requests to these never leave the machine. A name under
 * `.localhost` is not one of them: Node asks the DNS server for it, which may answer with any
 * address, so it counts as another machine.
 */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost') return true;
  if (host === '[::1]' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** A server address without a trailing `/v1`: where Ollama's own API lives. */
export function serverRoot(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * The OpenAI-compatible base of a server address: `/v1` is added to a bare `host:port`; an address
 * with a path is kept as typed (without a trailing slash).
 */
export function openAiBase(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  try {
    if (new URL(trimmed).pathname === '/') return `${trimmed}/v1`;
  } catch {
    return trimmed;
  }
  return trimmed;
}

export interface ModelRoute {
  task: AiTask;
  provider: AiProvider;
  model: string;
}

/** Defaults shown in Settings; the person can change every route. */
export function defaultRoutes(): ModelRoute[] {
  return [
    { task: 'chat', provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { task: 'vision', provider: 'anthropic', model: 'claude-opus-5-5' },
    { task: 'report', provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { task: 'extract', provider: 'openai', model: 'gpt-6-luna' },
    { task: 'build', provider: 'anthropic', model: 'claude-opus-5-5' },
  ];
}

/** The tasks the Offline agent preset routes to the local model, in Settings order. */
export const OFFLINE_TASKS: readonly AiTask[] = ['chat', 'vision', 'report', 'extract', 'build'];

/** Offline agent preset: every task on the local model, so nothing leaves the machine. */
export function offlineRoutes(model: string): ModelRoute[] {
  return OFFLINE_TASKS.map((task) => ({ task, provider: 'local', model }));
}

/** Every task of the preset runs on the local model. */
export function isOfflineAgent(routes: readonly ModelRoute[]): boolean {
  return OFFLINE_TASKS.every((task) => routes.find((r) => r.task === task)?.provider === 'local');
}

/**
 * The routes to go back to when the preset is turned off: the ones saved before it (JSON), unless
 * they are missing, unreadable or themselves all local; then the defaults.
 */
export function restoreRoutes(saved: string | null): ModelRoute[] {
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as unknown;
      if (Array.isArray(parsed) && parsed.every(isRoute) && !isOfflineAgent(parsed)) {
        return parsed;
      }
    } catch {
      // fall through to the defaults
    }
  }
  return defaultRoutes();
}

function isRoute(v: unknown): v is ModelRoute {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.task === 'string' &&
    typeof r.model === 'string' &&
    r.model.length > 0 &&
    (ROUTE_PROVIDERS as readonly unknown[]).includes(r.provider)
  );
}

/**
 * Models for Settings, Test connection, when no route uses the provider: the smallest current
 * model of each, so the test costs a fraction of a cent.
 */
export const TEST_MODELS: Record<(typeof PROVIDERS)[number], string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-6-luna',
  google: 'gemini-3.1-flash-lite',
};

export function routeFor(routes: readonly ModelRoute[], task: AiTask): ModelRoute {
  const r = routes.find((x) => x.task === task);
  if (!r) {
    throw new Error(
      `No model is set for the "${task}" task. Choose one in Settings, AI providers.`,
    );
  }
  return r;
}

/** Display names for providers, used in messages and the panel. */
export const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  local: 'Local model',
};

/** "Add an Anthropic key in Settings, AI providers." */
export function missingKeyMessage(label: string): string {
  const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
  return `Add ${article} ${label} key in Settings, AI providers.`;
}

/** Short model name for the meter, e.g. claude-sonnet-5-5 to Claude Sonnet 5.5. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (m?.[1] && m[2]) {
    const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return `Claude ${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  }
  if (model.startsWith('gpt-')) return `GPT-${model.slice(4)}`;
  if (model.startsWith('gemini-')) {
    return model
      .split('-')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }
  return model;
}
