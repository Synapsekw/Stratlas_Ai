import type { AiProvider, AiTask } from '@aio/schema';

export const PROVIDERS = ['anthropic', 'openai', 'google'] as const satisfies readonly AiProvider[];

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
    { task: 'extract', provider: 'openai', model: 'gpt-5-mini' },
    { task: 'build', provider: 'anthropic', model: 'claude-opus-5-5' },
  ];
}

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
