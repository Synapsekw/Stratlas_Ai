import type { SessionState } from '@aio/ai';
import { t } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import type { ResolvedBackend } from '../inspect/askAi/backend';
import { AI_CHECKING, AI_LOOK, aiStatus, type AiStatusInput } from './aiStatus';

type Agent = SessionState['availability'];

const route = (provider: string) =>
  ({ task: 'chat', provider, model: 'm' }) as unknown as Extract<
    Agent,
    { status: 'ready' }
  >['route'];
const READY_CLOUD: Agent = { status: 'ready', route: route('anthropic'), cloud: true };
const READY_LOCAL: Agent = { status: 'ready', route: route('local'), cloud: false };
const off = (reason: Extract<Agent, { status: 'disabled' }>['reason']): Agent => ({
  status: 'disabled',
  reason,
  message: reason,
});

const base: AiStatusInput = {
  settings: { cloudAi: true, offlineOnly: false },
  agent: off('no-key'),
  askBackend: null,
  projectPolicy: undefined,
  localModel: 'absent',
};
const status = (over: Partial<AiStatusInput>) => aiStatus({ ...base, ...over });
const label = (over: Partial<AiStatusInput>) => t(AI_LOOK[status(over).state].label);

describe('aiStatus: the D6 rows', () => {
  it('AI ready', () => {
    expect(status({ agent: READY_CLOUD })).toEqual({ state: 'ready', fix: null, checking: false });
    expect(label({ agent: READY_CLOUD })).toBe('AI ready');
    expect(AI_LOOK.ready.tone).toBe('ok');
  });
  it('Offline AI: the local model', () => {
    expect(status({ agent: READY_LOCAL, localModel: 'running' })).toEqual({
      state: 'local',
      fix: null,
      checking: false,
    });
    expect(label({ agent: READY_LOCAL })).toBe('Offline AI');
  });
  it('AI off: no key, amber, fixed in AI providers', () => {
    expect(status({ agent: off('no-key') })).toMatchObject({ state: 'no-key', fix: 'ai' });
    expect(label({ agent: off('no-key') })).toBe('AI off: no key');
    expect(AI_LOOK['no-key'].tone).toBe('warn');
  });
  it('AI off: offline, fixed in Privacy and cloud', () => {
    const s = { settings: { cloudAi: true, offlineOnly: true }, agent: off('offline-only') };
    expect(status(s)).toMatchObject({ state: 'offline', fix: 'privacy' });
    expect(label(s)).toBe('AI off: offline');
  });
  it('AI off for this project', () => {
    const s = { projectPolicy: 'forbid' as const, agent: off('forbidden') };
    expect(status(s)).toMatchObject({ state: 'project-off', fix: 'privacy' });
    expect(label(s)).toBe('AI off for this project');
    expect(AI_LOOK['project-off'].tone).toBe('warn');
  });
  it('AI off: the cloud switch off is neutral and opens Privacy and cloud, whatever the key', () => {
    const s = { settings: { cloudAi: false, offlineOnly: false }, agent: off('cloud-off') };
    expect(status(s)).toMatchObject({ state: 'cloud-off', fix: 'privacy' });
    expect(label(s)).toBe('AI off');
    expect(AI_LOOK['cloud-off'].tone).toBe('neutral');
  });
});

describe('aiStatus: the source combinations', () => {
  it('cloud on, no key is no-key, not ready', () => {
    expect(status({}).state).toBe('no-key');
  });
  it('project forbid beats a key', () => {
    expect(status({ projectPolicy: 'forbid', agent: READY_CLOUD }).state).toBe('project-off');
  });
  it('local model running with cloud off is local', () => {
    expect(
      status({
        settings: { cloudAi: false, offlineOnly: false },
        agent: READY_LOCAL,
        localModel: 'running',
      }).state,
    ).toBe('local');
    // and before the agent has answered
    expect(
      status({
        settings: { cloudAi: false, offlineOnly: false },
        agent: { status: 'checking' },
        localModel: 'running',
      }).state,
    ).toBe('local');
  });
  it('a request on the local model wins over every block', () => {
    for (const settings of [
      { cloudAi: false, offlineOnly: false },
      { cloudAi: true, offlineOnly: true },
    ])
      expect(status({ settings, projectPolicy: 'forbid', agent: READY_LOCAL }).state).toBe('local');
  });
  it('a local model whose route is refused is not Offline AI', () => {
    for (const reason of ['no-route', 'local-off'] as const)
      expect(status({ agent: off(reason), localModel: 'running' }).state).toBe('no-key');
    // while the agent checks, the local model on the chat route is Offline AI already
    expect(status({ agent: { status: 'checking' }, localModel: 'running' }).state).toBe('local');
  });
  it('offline only beats a key', () => {
    expect(
      status({ settings: { cloudAi: true, offlineOnly: true }, agent: READY_CLOUD }).state,
    ).toBe('offline');
  });
  it('the cloud switch off beats a stale ready', () => {
    expect(
      status({ settings: { cloudAi: false, offlineOnly: false }, agent: READY_CLOUD }).state,
    ).toBe('cloud-off');
  });
  it('key present but agent session disabled is never green', () => {
    for (const reason of ['no-route', 'no-provider', 'local-off', 'no-bridge'] as const)
      expect(status({ agent: off(reason) }).state).toBe('no-key');
  });
  it('Ask AI photo backend: cloud is ready, local is local', () => {
    const cloud: ResolvedBackend = { kind: 'cloud', provider: 'anthropic', model: 'm' };
    expect(status({ askBackend: cloud }).state).toBe('ready');
    const local = { kind: 'local', model: { id: 'x' } } as unknown as ResolvedBackend;
    expect(status({ askBackend: local }).state).toBe('local');
    expect(status({ askBackend: cloud, projectPolicy: 'forbid' }).state).toBe('project-off');
  });
});

describe('aiStatus: start-up', () => {
  it('while the agent checks, the chip is neutral, never amber', () => {
    expect(status({ agent: { status: 'checking' } })).toEqual({
      state: 'no-key',
      fix: 'ai',
      checking: true,
    });
    expect(t(AI_CHECKING.label)).toBe('Checking AI');
  });
  it('a cloud switch the agent has not seen turn on yet is checking, not off', () => {
    expect(status({ agent: off('cloud-off') }).checking).toBe(true);
    expect(status({ agent: off('offline-only') }).checking).toBe(true);
  });
  it('a project policy the agent has not seen change yet is checking, not off', () => {
    expect(status({ agent: off('forbidden') }).checking).toBe(true);
    expect(status({ agent: off('forbidden'), projectPolicy: 'forbid' })).toMatchObject({
      state: 'project-off',
      checking: false,
    });
  });
  it('a block that is known now does not wait for the agent', () => {
    expect(
      status({ settings: { cloudAi: false, offlineOnly: false }, agent: { status: 'checking' } }),
    ).toMatchObject({ state: 'cloud-off', checking: false });
  });
});
