import type {
  AioBridge,
  IpcChannel,
  IpcEvent,
  IpcRequest,
  IpcResponse,
  Settings,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { RendererToolContext } from './renderer-tools';
import { AgentSession } from './session';
import { fixtureWorkspace } from './test-fixtures';

interface Call {
  channel: IpcChannel;
  req: unknown;
}

function fakeBridge(opts: { cloudAi?: boolean; hasKey?: boolean; sendError?: string } = {}) {
  const calls: Call[] = [];
  let listener: ((e: IpcEvent<'ai:event'>) => void) | null = null;
  const settings: Settings = {
    cloudAi: opts.cloudAi ?? true,
    theme: 'dark',
    sidebarCollapsed: false,
    dataRoot: 'E:/data',
    routes: [{ task: 'chat', provider: 'openai', model: 'gpt-5' }],
  };
  const bridge: AioBridge = {
    invoke: <C extends IpcChannel>(channel: C, req: IpcRequest<C>) => {
      calls.push({ channel, req });
      const answer: Partial<Record<IpcChannel, unknown>> = {
        'settings:get': settings,
        'ai:hasKey': { present: opts.hasKey ?? true },
        'ai:send': opts.sendError ? { ok: false, error: opts.sendError } : { ok: true },
        'ai:toolResult': { ok: true },
        'ai:cancel': { ok: true },
      };
      return Promise.resolve(answer[channel] as IpcResponse<C>);
    },
    on: (_event, l) => {
      listener = l as (e: IpcEvent<'ai:event'>) => void;
      return () => {
        listener = null;
      };
    },
  };
  const emit = (e: IpcEvent<'ai:event'>) => listener?.(e);
  const sent = (channel: IpcChannel) => calls.filter((c) => c.channel === channel);
  return { bridge, emit, sent };
}

function setup(opts: Parameters<typeof fakeBridge>[0] = {}) {
  const b = fakeBridge(opts);
  const ws = fixtureWorkspace();
  let n = 0;
  const toolContext = (): RendererToolContext => ({
    workspace: ws,
    window: 'scene3d',
    scene: () => null,
    fetchJson: () => Promise.reject(new Error('offline')),
    captureFrame: () => Promise.resolve('data:image/jpeg;base64,AAAA'),
    now: () => new Date('2026-10-03T12:00:00Z'),
  });
  const session = new AgentSession({
    bridge: b.bridge,
    window: 'scene3d',
    toolContext,
    newId: () => `id${++n}`,
  });
  session.connect();
  return { ...b, ws, session };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('agent session availability', () => {
  it('explains how to enable cloud AI', async () => {
    const t = setup({ cloudAi: false });
    await t.session.refresh();
    expect(t.session.getState().availability).toMatchObject({ reason: 'cloud-off' });
  });

  it('names the provider whose key is missing', async () => {
    const t = setup({ hasKey: false });
    await t.session.refresh();
    expect(t.session.getState().availability).toMatchObject({
      reason: 'no-key',
      message: 'Add an OpenAI key in Settings, AI providers.',
    });
  });

  it('is ready with cloud AI on and a key', async () => {
    const t = setup();
    await t.session.refresh();
    expect(t.session.getState().availability).toMatchObject({
      status: 'ready',
      route: { model: 'gpt-5' },
    });
  });

  it('is disabled outside the desktop app', async () => {
    const s = new AgentSession({
      bridge: null,
      window: 'map',
      toolContext: () => {
        throw new Error('unused');
      },
    });
    await s.refresh();
    expect(s.getState().availability).toMatchObject({ reason: 'no-bridge' });
  });
});

describe('agent session conversation', () => {
  it('sends the window context and history, then streams the reply', async () => {
    const t = setup();
    t.ws.getState().select({ kind: 'asset', id: '20-T-0002' });
    await t.session.send('What is this?');
    const req = t.sent('ai:send')[0]?.req as IpcRequest<'ai:send'>;
    expect(req).toMatchObject({
      runId: 'id1',
      window: 'scene3d',
      messages: [{ role: 'user', content: 'What is this?' }],
      context: { selection: { id: '20-T-0002' } },
    });
    t.emit({ type: 'text', runId: 'id1', delta: 'A tank' });
    t.emit({ type: 'text', runId: 'id1', delta: ' roof.' });
    t.emit({ type: 'usage', runId: 'id1', inputTokens: 1000, outputTokens: 50, costUsd: 0.01 });
    t.emit({ type: 'done', runId: 'id1' });
    const s = t.session.getState();
    expect(s.busy).toBe(false);
    expect(s.turns[1]).toMatchObject({
      status: 'done',
      parts: [{ type: 'text', text: 'A tank roof.' }],
    });
    expect(s.usage).toMatchObject({ inputTokens: 1000, outputTokens: 50, costUsd: 0.01 });

    await t.session.send('And the next one?');
    const second = t.sent('ai:send')[1]?.req as IpcRequest<'ai:send'>;
    expect(second.messages).toEqual([
      { role: 'user', content: 'What is this?' },
      { role: 'assistant', content: 'A tank roof.' },
      { role: 'user', content: 'And the next one?' },
    ]);
  });

  it('attaches the current frame when asked', async () => {
    const t = setup();
    await t.session.send('Look', { attachFrame: true });
    expect(t.sent('ai:send')[0]?.req).toMatchObject({ image: 'data:image/jpeg;base64,AAAA' });
  });

  it('shows a send refusal as an error on the reply', async () => {
    const t = setup({ sendError: 'Cloud AI is off.' });
    await t.session.send('hi');
    expect(t.session.getState().turns[1]).toMatchObject({
      status: 'error',
      error: 'Cloud AI is off.',
    });
    expect(t.session.getState().busy).toBe(false);
  });

  it('runs read and navigate tools at once and returns the result', async () => {
    const t = setup();
    await t.session.send('hide the mesh');
    t.emit({
      type: 'tool-call',
      runId: 'id1',
      callId: 'c1',
      name: 'set_layer_visible',
      input: { layerId: 'm1', visible: false },
      risk: 'navigate',
    });
    await flush();
    expect(t.ws.getState().isLayerVisible('m1')).toBe(false);
    expect(t.session.getState().steps.c1).toMatchObject({ status: 'done', canUndo: true });
    expect(t.sent('ai:toolResult')[0]?.req).toMatchObject({
      callId: 'c1',
      approved: true,
      result: { layer: 'm1', visible: false },
    });
    t.session.undo('c1');
    expect(t.ws.getState().isLayerVisible('m1')).toBe(true);
    expect(t.session.getState().steps.c1?.status).toBe('undone');
  });

  it('waits for approval of a write tool, then runs it', async () => {
    const t = setup();
    await t.session.send('draft it');
    t.emit({
      type: 'tool-call',
      runId: 'id1',
      callId: 'c1',
      name: 'create_issue_draft',
      input: {
        title: 'Rust',
        severity: 3,
        classId: 'corrosion',
        at: { kind: 'point', p: [0, 0, 0] },
      },
      risk: 'write',
    });
    await flush();
    expect(t.session.getState().steps.c1?.status).toBe('awaiting');
    expect(t.sent('ai:toolResult')).toHaveLength(0);
    expect(t.ws.getState().issues).toHaveLength(3);
    await t.session.approve('c1');
    expect(t.ws.getState().issues).toHaveLength(4);
    expect(t.sent('ai:toolResult')[0]?.req).toMatchObject({
      approved: true,
      result: { code: 'AG01' },
    });
  });

  it('reports a rejection without running the tool', async () => {
    const t = setup();
    await t.session.send('draft it');
    t.emit({
      type: 'tool-call',
      runId: 'id1',
      callId: 'c1',
      name: 'create_issue_draft',
      input: { title: 'Rust', severity: 3 },
      risk: 'write',
    });
    t.session.reject('c1');
    expect(t.session.getState().steps.c1?.status).toBe('rejected');
    expect(t.sent('ai:toolResult')[0]?.req).toEqual({
      runId: 'id1',
      callId: 'c1',
      approved: false,
    });
    expect(t.ws.getState().issues).toHaveLength(3);
  });

  it('sends tool failures back as fixed text', async () => {
    const t = setup();
    await t.session.send('hide x');
    t.emit({
      type: 'tool-call',
      runId: 'id1',
      callId: 'c1',
      name: 'set_layer_visible',
      input: { layerId: 'nope', visible: false },
      risk: 'navigate',
    });
    await flush();
    expect(t.session.getState().steps.c1?.status).toBe('error');
    expect(t.sent('ai:toolResult')[0]?.req).toMatchObject({
      approved: true,
      error: 'No layer "nope" in this project. Use list_layers.',
    });
  });

  it('cancels: tells main, stops the reply and drops pending approvals', async () => {
    const t = setup();
    await t.session.send('draft it');
    t.emit({
      type: 'tool-call',
      runId: 'id1',
      callId: 'c1',
      name: 'create_issue_draft',
      input: { title: 'Rust', severity: 3 },
      risk: 'write',
    });
    t.session.cancel();
    expect(t.sent('ai:cancel')[0]?.req).toEqual({ runId: 'id1' });
    const s = t.session.getState();
    expect(s.turns[1]).toMatchObject({ status: 'stopped' });
    expect(s.steps.c1?.status).toBe('cancelled');
    expect(s.busy).toBe(false);
    t.emit({ type: 'error', runId: 'id1', message: 'Stopped.' });
    expect(t.session.getState().turns[1]).toMatchObject({ status: 'stopped' });
  });

  it('ignores events from other runs', async () => {
    const t = setup();
    await t.session.send('hi');
    t.emit({ type: 'text', runId: 'someone-else', delta: 'nope' });
    expect(t.session.getState().turns[1]).toMatchObject({ parts: [] });
  });
});
