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
export { AgentPanel, type AgentPanelProps } from './AgentPanel';
