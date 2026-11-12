import type {
  AioBridge,
  AiTask,
  Conversation,
  IpcChannel,
  IpcEvent,
  IpcRequest,
  IpcResponse,
} from '@aio/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerRendererTool, type AppHooks, type RendererToolContext } from './renderer-tools';
import { registerToolSpec } from './tools';
import { AgentSession, resetPreviewMemory } from './session';
import { fixtureWorkspace } from './test-fixtures';

interface Call {
  channel: IpcChannel;
  req: unknown;
}

interface BridgeOpts {
  cloudAi?: boolean;
  hasKey?: boolean;
  sendError?: string;
  /** Default true so the conversation tests are not stopped by the send preview. */
  alwaysAllow?: boolean;
  cloud?: boolean;
  saved?: Conversation;
  /** The ready route can only answer in text (a local model without tool calling). */
  answerOnly?: string;
  /** The project lets the agent capture the view without asking (A3). */
  viewCapture?: boolean;
}

function fakeBridge(opts: BridgeOpts = {}) {
  const calls: Call[] = [];
  let listener: ((e: IpcEvent<'ai:event'>) => void) | null = null;
  const route = { task: 'chat' as const, provider: 'openai' as const, model: 'gpt-5' };
  const status: IpcResponse<'ai:status'> =
    opts.cloudAi === false
      ? { ready: false, reason: 'cloud-off', message: 'Cloud AI is off.', cloud: true, route }
      : opts.hasKey === false
        ? {
            ready: false,
            reason: 'no-key',
            message: 'Add an OpenAI key in Settings, AI providers.',
            cloud: true,
            route,
          }
        : opts.answerOnly
          ? { ready: true, route, cloud: false, reason: 'answer-only', message: opts.answerOnly }
          : { ready: true, route, cloud: opts.cloud ?? true };
  const bridge: AioBridge = {
    invoke: <C extends IpcChannel>(channel: C, req: IpcRequest<C>) => {
      calls.push({ channel, req });
      const answer: Partial<Record<IpcChannel, unknown>> = {
        'ai:status': {
          ...status,
          route: { ...route, task: (req as IpcRequest<'ai:status'>).task ?? 'chat' },
        },
        'ai:project': {
          alwaysAllow: opts.alwaysAllow ?? true,
          ...(opts.viewCapture !== undefined ? { viewCapture: opts.viewCapture } : {}),
          policy: 'allow',
          usage: [
            {
              provider: 'openai',
              inputTokens: 500,
              outputTokens: 10,
              costUsd: 0.5,
              costKnown: true,
            },
          ],
        },
        'ai:setConsent': { ok: true },
        'ai:setViewCapture': { ok: true },
        'ai:send': opts.sendError ? { ok: false, error: opts.sendError } : { ok: true },
        'ai:toolResult': { ok: true },
        'ai:cancel': { ok: true },
        'ai:saveConversation': { ok: true },
        'ai:listConversations': {
          ok: true,
          conversations: opts.saved
            ? [
                {
                  id: opts.saved.id,
                  title: opts.saved.title,
                  window: opts.saved.window,
                  createdAt: opts.saved.createdAt,
                  updatedAt: opts.saved.updatedAt,
                  turns: opts.saved.turns.length,
                  pending: 1,
                },
              ]
            : [],
        },
        'ai:loadConversation': opts.saved
          ? { ok: true, conversation: opts.saved }
          : { ok: false, error: 'Not found.' },
        'dialog:saveFile': { path: 'C:/out/chat.md' },
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

beforeEach(() => {
  resetPreviewMemory();
});

function setup(opts: BridgeOpts = {}, app?: AppHooks, task?: () => AiTask | undefined) {
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
    ...(app ? { app } : {}),
  });
  const session = new AgentSession({
    bridge: b.bridge,
    window: 'scene3d',
    toolContext,
    newId: () => `id${++n}`,
    now: () => new Date('2026-10-04T10:00:00Z'),
    saveDelayMs: 0,
    ...(task ? { task } : {}),
  });
  session.connect();
  return { ...b, ws, session };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('agent session availability', () => {
  it('checks the active task route for readiness and consent instead of the chat default', async () => {
    let task: AiTask | undefined = 'build';
    const t = setup({}, undefined, () => task);
    await t.session.refresh();
    expect(t.sent('ai:status').at(-1)?.req).toMatchObject({ task: 'build' });
    task = undefined;
    await t.session.refresh();
    expect(t.sent('ai:status').at(-1)?.req).not.toHaveProperty('task');
  });
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

  it('stays ready with the reason when the local model can only answer in text', async () => {
    const t = setup({ answerOnly: 'This local model cannot use the app tools.' });
    await t.session.refresh();
    expect(t.session.getState().availability).toEqual({
      status: 'ready',
      route: { task: 'chat', provider: 'openai', model: 'gpt-5' },
      cloud: false,
      notice: 'This local model cannot use the app tools.',
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
  it('sends the screen that is showing and the severity level names', async () => {
    const t = setup({}, { screen: () => 'inspect' });
    await t.session.send('Open the worst photos');
    const req = t.sent('ai:send')[0]?.req as IpcRequest<'ai:send'>;
    expect(req.context).toMatchObject({
      screen: 'inspect',
      severityLevels: [
        { model: 'sev', levels: expect.arrayContaining([{ value: 1, label: 'S1' }]) as unknown },
      ],
    });
  });

  it('sends no screen when the app has no hook for it', async () => {
    const t = setup();
    await t.session.send('What is this?');
    const req = t.sent('ai:send')[0]?.req as IpcRequest<'ai:send'>;
    expect(req.context).not.toHaveProperty('screen');
  });

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

  it('keeps a step done, with the reason, when its undo is refused; waits for an async undo', async () => {
    let answer: string | null = 'A later review came in.';
    registerToolSpec({
      meta: {
        name: 'test_guarded_undo',
        description: 'A test tool.',
        scope: 'project',
        risk: 'navigate',
      },
      input: z.object({}),
      undoable: true,
    });
    registerRendererTool('test_guarded_undo', () =>
      Promise.resolve({ result: {}, summary: 'did it', undo: () => Promise.resolve(answer) }),
    );
    const t = setup();
    await t.session.send('do it');
    for (const callId of ['g1', 'g2']) {
      t.emit({
        type: 'tool-call',
        runId: 'id1',
        callId,
        name: 'test_guarded_undo',
        input: {},
        risk: 'navigate',
      });
    }
    await flush();
    t.session.undo('g1');
    await flush();
    expect(t.session.getState().steps.g1).toMatchObject({
      status: 'done',
      canUndo: false,
      summary: 'did it · A later review came in.',
    });
    answer = null;
    t.session.undo('g2');
    await flush();
    expect(t.session.getState().steps.g2?.status).toBe('undone');
  });

  it('keeps the compacted result and sends the tool work with the next message', async () => {
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
    expect(t.session.getState().steps.c1?.result).toBe('{"layer":"m1","visible":false}');
    // main names the provider that answered the step
    t.emit({ type: 'usage', runId: 'id1', inputTokens: 1, outputTokens: 1, provider: 'openai' });
    t.emit({ type: 'text', runId: 'id1', delta: 'Hidden.' });
    t.emit({ type: 'done', runId: 'id1' });
    await t.session.send('Show it again');
    const second = t.sent('ai:send')[1]?.req as IpcRequest<'ai:send'>;
    expect(second.messages).toEqual([
      { role: 'user', content: 'hide the mesh' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { callId: 'c1', name: 'set_layer_visible', input: { layerId: 'm1', visible: false } },
        ],
      },
      {
        role: 'tool',
        results: [
          {
            callId: 'c1',
            name: 'set_layer_visible',
            status: 'ok',
            output: '{"layer":"m1","visible":false}',
          },
        ],
      },
      { role: 'assistant', content: 'Hidden.' },
      { role: 'user', content: 'Show it again' },
    ]);
  });

  it('records the provider and the model step of each call', async () => {
    const t = setup();
    await t.session.refresh(); // the route is known
    await t.session.send('look around');
    const call = (callId: string) =>
      t.emit({
        type: 'tool-call',
        runId: 'id1',
        callId,
        name: 'list_layers',
        input: {},
        risk: 'read',
      });
    call('c1');
    call('c2');
    t.emit({ type: 'usage', runId: 'id1', inputTokens: 1, outputTokens: 1, provider: 'openai' });
    call('c3');
    await flush();
    let steps = t.session.getState().steps;
    // the step still running has no provider until main reports it
    expect([steps.c1, steps.c2, steps.c3].map((s) => [s?.provider, s?.batch])).toEqual([
      ['openai', 0],
      ['openai', 0],
      [undefined, 1],
    ]);
    t.emit({ type: 'usage', runId: 'id1', inputTokens: 1, outputTokens: 1, provider: 'google' });
    steps = t.session.getState().steps;
    expect(steps.c3?.provider).toBe('google');
  });

  it('labels a step with the provider main used, not the route the panel expected (AI-6)', async () => {
    // the panel's route is a cloud one (openai), but main answered on the local model
    const t = setup();
    await t.session.refresh();
    await t.session.send('where is it');
    t.emit({
      type: 'tool-call',
      runId: 'id1',
      callId: 'c1',
      name: 'set_layer_visible',
      input: { layerId: 'm1', visible: false },
      risk: 'navigate',
    });
    await flush();
    t.emit({ type: 'usage', runId: 'id1', inputTokens: 1, outputTokens: 1, provider: 'local' });
    t.emit({ type: 'text', runId: 'id1', delta: 'Hidden.' });
    t.emit({ type: 'done', runId: 'id1' });
    expect(t.session.getState().steps.c1?.provider).toBe('local');
    await t.session.send('And now?');
    const second = t.sent('ai:send')[1]?.req as IpcRequest<'ai:send'>;
    const json = JSON.stringify(second.messages);
    // the summary of the step went, not its result
    expect(json).not.toContain('\\"visible\\":false');
    expect(json).toContain(t.session.getState().steps.c1?.summary ?? 'no summary');
  });

  it('sends only the summary of a local model step to a cloud provider (AI-6)', async () => {
    const saved: Conversation = {
      schema: 'aio.conversation/1',
      id: 'mixed',
      title: 'Mixed',
      window: 'scene3d',
      createdAt: '2026-10-03T10:00:00.000Z',
      updatedAt: '2026-10-03T10:01:00.000Z',
      turns: [
        { kind: 'user', id: 'u1', text: 'Where is it?', chips: [], frame: false },
        {
          kind: 'assistant',
          id: 'a1',
          runId: 'r-old',
          parts: [
            { type: 'step', callId: 'k1' },
            { type: 'text', text: 'Found it.' },
          ],
          status: 'done',
        },
      ],
      steps: {
        k1: {
          callId: 'k1',
          name: 'find_places',
          input: { query: 'tank' },
          risk: 'read',
          status: 'done',
          canUndo: false,
          summary: '1 place',
          result: '{"places":[{"id":"T-9","name":"on this PC only"}]}',
          provider: 'local',
        },
      },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, costKnown: true },
    };
    const t = setup({ saved, cloud: true });
    await t.session.resume('mixed');
    await t.session.send('Fly there');
    const req = t.sent('ai:send')[0]?.req as IpcRequest<'ai:send'>;
    const json = JSON.stringify(req.messages);
    expect(json).toContain('1 place');
    expect(json).not.toContain('on this PC only');
  });

  it('sends what the project has, so only fitting tools are offered', async () => {
    const t = setup();
    await t.session.send('What is here?');
    const req = t.sent('ai:send')[0]?.req as IpcRequest<'ai:send'>;
    expect(req.facts).toMatchObject({
      captures: expect.any(Number) as unknown,
      photos: expect.any(Boolean) as unknown,
      clips: expect.any(Boolean) as unknown,
      pointClouds: expect.any(Boolean) as unknown,
    });
    expect(req.facts).not.toHaveProperty('models');
  });

  it('adds what the app knows beyond the manifest, and leaves out what it cannot tell', async () => {
    const t = setup(
      {},
      {
        agentFacts: () => ({ walks: false, volumes: true, thermal: 'maybe' as unknown as boolean }),
      },
    );
    await t.session.send('What is here?');
    const req = t.sent('ai:send')[0]?.req as IpcRequest<'ai:send'>;
    expect(req.facts).toMatchObject({ walks: false, volumes: true });
    expect(req.facts).not.toHaveProperty('thermal');
    expect(req.facts).not.toHaveProperty('detections');
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

describe('provider errors fixed in place', () => {
  const WORKSPACE =
    'Anthropic: This API key is not scoped to a workspace. (HTTP 400) Enter the workspace ID.';

  it('offers the fix for a coded error and sends the failed message again once fixed', async () => {
    const t = setup();
    await t.session.send('Hello');
    const first = t.sent('ai:send')[0]?.req as IpcRequest<'ai:send'>;
    t.emit({ type: 'error', runId: first.runId, message: WORKSPACE, code: 'anthropic-workspace' });
    let s = t.session.getState();
    expect(s.turns[1]).toMatchObject({ status: 'error', error: WORKSPACE });
    expect(s.fix).toEqual({ code: 'anthropic-workspace', runId: first.runId, text: 'Hello' });

    await t.session.retry();
    s = t.session.getState();
    expect(s.fix).toBeNull();
    // The failed exchange is replaced: the message is in the conversation once.
    expect(s.turns.filter((x) => x.kind === 'user')).toHaveLength(1);
    expect(s.turns.some((x) => x.kind === 'assistant' && x.status === 'error')).toBe(false);
    const again = t.sent('ai:send')[1]?.req as IpcRequest<'ai:send'>;
    expect(again.runId).not.toBe(first.runId);
    expect(again.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    t.emit({ type: 'text', runId: again.runId, delta: 'Hi.' });
    t.emit({ type: 'done', runId: again.runId });
    expect(t.session.getState().turns.at(-1)).toMatchObject({ status: 'done' });
  });

  it('offers no fix for other errors, and the card can be dismissed', async () => {
    const t = setup();
    await t.session.send('Hello');
    const run = (t.sent('ai:send')[0]?.req as IpcRequest<'ai:send'>).runId;
    t.emit({ type: 'error', runId: run, message: 'Anthropic had a server error.' });
    expect(t.session.getState().fix).toBeNull();
    await t.session.retry();
    expect(t.sent('ai:send')).toHaveLength(1);

    await t.session.send('Again');
    const second = (t.sent('ai:send')[1]?.req as IpcRequest<'ai:send'>).runId;
    t.emit({ type: 'error', runId: second, message: WORKSPACE, code: 'anthropic-workspace' });
    expect(t.session.getState().fix).not.toBeNull();
    t.session.dismissFix();
    expect(t.session.getState().fix).toBeNull();
    // The error stays in the conversation.
    expect(t.session.getState().turns.at(-1)).toMatchObject({ status: 'error' });
  });

  it('drops the fix on a new conversation', async () => {
    const t = setup();
    await t.session.send('Hello');
    const run = (t.sent('ai:send')[0]?.req as IpcRequest<'ai:send'>).runId;
    t.emit({ type: 'error', runId: run, message: WORKSPACE, code: 'anthropic-workspace' });
    t.session.reset();
    expect(t.session.getState().fix).toBeNull();
  });
});

describe('send preview (AI-6)', () => {
  it('previews the captured task route even when cached availability belongs to another tab', async () => {
    let task: AiTask | undefined;
    const t = setup({ alwaysAllow: false }, undefined, () => task);
    await t.session.refresh();
    task = 'build';
    await t.session.send('Review these model corrections.');
    expect(t.session.getState().preview?.route.task).toBe('build');
    expect(t.sent('ai:status').at(-1)?.req).toMatchObject({ task: 'build' });
    task = undefined;
    await t.session.confirmPreview();
    expect(t.sent('ai:send')[0]?.req).toMatchObject({ task: 'build' });
  });

  it('keeps the previewed build task after the active tab returns to chat', async () => {
    let task: AiTask | undefined = 'build';
    const t = setup({ alwaysAllow: false }, undefined, () => task);
    await t.session.refresh();
    await t.session.send('Review these model corrections.');
    expect(t.session.getState().preview?.route.task).toBe('build');
    task = undefined;
    await t.session.refresh();
    await t.session.confirmPreview();
    expect(t.sent('ai:send')[0]?.req).toMatchObject({ task: 'build' });
  });

  it('does not redirect a chat preview to build when the active task changes', async () => {
    let task: AiTask | undefined = undefined;
    const t = setup({ alwaysAllow: false }, undefined, () => task);
    await t.session.refresh();
    await t.session.send('Review this selection.');
    task = 'build';
    await t.session.confirmPreview();
    expect(t.sent('ai:send')[0]?.req).not.toHaveProperty('task');
  });

  it('keeps the initiating task while an attached frame is captured asynchronously', async () => {
    let task: AiTask | undefined = 'build';
    const t = setup({}, undefined, () => task);
    await t.session.refresh();
    const sending = t.session.send('Review this model view.', { attachFrame: true });
    task = undefined;
    await sending;
    expect(t.sent('ai:send')[0]?.req).toMatchObject({
      task: 'build',
      image: 'data:image/jpeg;base64,AAAA',
    });
  });

  it('shows what will be sent before the first cloud send in a project', async () => {
    const t = setup({ alwaysAllow: false });
    await t.session.refresh();
    await t.session.send('Look at this', { attachFrame: true });
    expect(t.sent('ai:send')).toHaveLength(0);
    expect(t.session.getState().preview).toMatchObject({
      text: 'Look at this',
      image: 'data:image/jpeg;base64,AAAA',
      route: { provider: 'openai', model: 'gpt-5' },
      context: { window: 'scene3d', project: { name: 'Tank farm' } },
    });
    await t.session.confirmPreview();
    expect(t.session.getState().preview).toBeNull();
    expect(t.sent('ai:send')[0]?.req).toMatchObject({
      projectId: 'p1',
      image: 'data:image/jpeg;base64,AAAA',
    });
    expect(t.sent('ai:setConsent')).toHaveLength(0);
    t.emit({ type: 'done', runId: 'id1' });
    // Once confirmed, later sends in this project go straight out.
    await t.session.send('And now?');
    expect(t.sent('ai:send')).toHaveLength(2);
  });

  it('stores "Always allow for this project"', async () => {
    const t = setup({ alwaysAllow: false });
    await t.session.refresh();
    await t.session.send('hi');
    await t.session.confirmPreview({ always: true });
    expect(t.sent('ai:setConsent')[0]?.req).toEqual({ projectId: 'p1', alwaysAllow: true });
    expect(t.session.getState().alwaysAllow).toBe(true);
  });

  it('sends nothing when the preview is cancelled', async () => {
    const t = setup({ alwaysAllow: false });
    await t.session.refresh();
    await t.session.send('hi');
    t.session.cancelPreview();
    expect(t.session.getState().preview).toBeNull();
    expect(t.sent('ai:send')).toHaveLength(0);
    expect(t.session.getState().turns).toHaveLength(0);
  });

  it('skips the preview for a local model', async () => {
    const t = setup({ alwaysAllow: false, cloud: false });
    await t.session.refresh();
    await t.session.send('hi');
    expect(t.session.getState().preview).toBeNull();
    expect(t.sent('ai:send')).toHaveLength(1);
  });
});

describe('history and the project meter', () => {
  it('saves the conversation to the project after a reply', async () => {
    const t = setup();
    await t.session.send('What is open?');
    t.emit({ type: 'text', runId: 'id1', delta: 'Two issues.' });
    t.emit({ type: 'done', runId: 'id1' });
    await t.session.settled();
    const last = t.sent('ai:saveConversation').at(-1)?.req as IpcRequest<'ai:saveConversation'>;
    expect(last.projectId).toBe('p1');
    expect(last.conversation).toMatchObject({
      schema: 'aio.conversation/1',
      id: 'id2',
      title: 'What is open?',
      window: 'scene3d',
      turns: [
        { kind: 'user', text: 'What is open?' },
        { kind: 'assistant', status: 'done', parts: [{ type: 'text', text: 'Two issues.' }] },
      ],
    });
  });

  it('adds usage to the project meter per provider', async () => {
    const t = setup();
    await t.session.refresh();
    await t.session.send('hi');
    t.emit({
      type: 'usage',
      runId: 'id1',
      inputTokens: 100,
      outputTokens: 5,
      costUsd: 0.25,
      provider: 'openai',
      model: 'gpt-5',
    });
    expect(t.session.getState().projectUsage).toEqual([
      { provider: 'openai', inputTokens: 600, outputTokens: 15, costUsd: 0.75, costKnown: true },
    ]);
  });

  it('exports the conversation as Markdown', async () => {
    const t = setup();
    await t.session.send('Summarise');
    t.emit({ type: 'text', runId: 'id1', delta: 'All good.' });
    t.emit({ type: 'done', runId: 'id1' });
    const r = await t.session.exportMarkdown();
    expect(r).toEqual({ path: 'C:/out/chat.md' });
    const req = t.sent('dialog:saveFile')[0]?.req as IpcRequest<'dialog:saveFile'>;
    expect(req.defaultName).toBe('Tank farm agent 2026-10-04-10-00.md');
    expect(req.data).toContain('## You\n\nSummarise');
    expect(req.data).toContain('All good.');
  });
});

describe('approvals after a restart', () => {
  const saved: Conversation = {
    schema: 'aio.conversation/1',
    id: 'old',
    title: 'Draft it',
    window: 'map',
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:01:00.000Z',
    turns: [
      { kind: 'user', id: 'u1', text: 'Draft it', chips: [], frame: false },
      {
        kind: 'assistant',
        id: 'a1',
        runId: 'r-old',
        parts: [
          { type: 'step', callId: 'k1' },
          { type: 'step', callId: 'k2' },
        ],
        status: 'streaming',
      },
    ],
    steps: {
      k1: {
        callId: 'k1',
        name: 'create_issue_draft',
        input: {
          title: 'Rust',
          severity: 3,
          classId: 'corrosion',
          at: { kind: 'point', p: [0, 0, 0] },
        },
        risk: 'write',
        status: 'awaiting',
        canUndo: false,
      },
      k2: {
        callId: 'k2',
        name: 'list_issues',
        input: {},
        risk: 'read',
        status: 'running',
        canUndo: false,
      },
    },
    usage: { inputTokens: 10, outputTokens: 2, costUsd: 0, costKnown: true },
  };

  it('lists saved conversations and restores waiting approvals as waiting', async () => {
    const t = setup({ saved });
    await t.session.listHistory();
    expect(t.session.getState().history).toMatchObject([{ id: 'old', pending: 1 }]);
    expect(await t.session.resume('old')).toBeNull();
    const s = t.session.getState();
    expect(s.id).toBe('old');
    expect(s.steps.k1?.status).toBe('awaiting');
    expect(s.steps.k2?.status).toBe('cancelled');
    expect(s.turns[1]).toMatchObject({ status: 'stopped' });
    // Nothing ran on its own.
    expect(t.ws.getState().issues).toHaveLength(3);
    expect(t.sent('ai:toolResult')).toHaveLength(0);
  });

  it('runs a restored approval only on approve and notes it for the model', async () => {
    const t = setup({ saved });
    await t.session.resume('old');
    await t.session.approve('k1');
    expect(t.ws.getState().issues).toHaveLength(4);
    expect(t.session.getState().steps.k1).toMatchObject({
      status: 'done',
      summary: 'AG01 drafted',
    });
    expect(t.sent('ai:toolResult')).toHaveLength(0);
    const reply = t.session.getState().turns[1];
    expect(reply?.kind === 'assistant' ? reply.parts.at(-1) : null).toEqual({
      type: 'text',
      text: '\n(Approved later and run: create_issue_draft, AG01 drafted.)',
    });
    await t.session.settled();
    const last = t.sent('ai:saveConversation').at(-1)?.req as IpcRequest<'ai:saveConversation'>;
    expect(last.conversation.steps.k1?.status).toBe('done');
  });

  it('rejects a restored approval without running it', async () => {
    const t = setup({ saved });
    await t.session.resume('old');
    t.session.reject('k1');
    expect(t.session.getState().steps.k1?.status).toBe('rejected');
    expect(t.ws.getState().issues).toHaveLength(3);
    expect(t.sent('ai:toolResult')).toHaveLength(0);
  });

  it('keeps a waiting approval waiting in the saved file when the panel closes', async () => {
    const b = fakeBridge();
    const ws = fixtureWorkspace();
    let n = 0;
    const session = new AgentSession({
      bridge: b.bridge,
      window: 'scene3d',
      toolContext: () => ({
        workspace: ws,
        window: 'scene3d',
        scene: () => null,
        fetchJson: () => Promise.reject(new Error('offline')),
        captureFrame: () => Promise.resolve(null),
        now: () => new Date(),
      }),
      newId: () => `id${++n}`,
      saveDelayMs: 10_000,
    });
    const disconnect = session.connect();
    await session.send('draft it');
    b.emit({
      type: 'tool-call',
      runId: 'id1',
      callId: 'c1',
      name: 'create_issue_draft',
      input: { title: 'Rust', severity: 3 },
      risk: 'write',
    });
    disconnect();
    await session.settled();
    const last = b.sent('ai:saveConversation').at(-1)?.req as IpcRequest<'ai:saveConversation'>;
    expect(last.conversation.steps.c1?.status).toBe('awaiting');
  });
});

describe('batch approvals (A3)', () => {
  const draft = (title: string) => ({
    title,
    severity: 3,
    classId: 'corrosion',
    at: { kind: 'point', p: [0, 0, 0] },
  });

  async function threeWrites(t: ReturnType<typeof setup>, failSecond = false) {
    await t.session.send('draft three');
    t.emit({
      type: 'tool-call',
      runId: 'id1',
      callId: 'b1',
      name: 'create_issue_draft',
      input: draft('One'),
      risk: 'write',
    });
    t.emit(
      failSecond
        ? {
            type: 'tool-call',
            runId: 'id1',
            callId: 'b2',
            name: 'set_layer_visible',
            input: { layerId: 'nope', visible: false },
            risk: 'write',
          }
        : {
            type: 'tool-call',
            runId: 'id1',
            callId: 'b2',
            name: 'create_issue_draft',
            input: draft('Two'),
            risk: 'write',
          },
    );
    t.emit({
      type: 'tool-call',
      runId: 'id1',
      callId: 'b3',
      name: 'create_issue_draft',
      input: draft('Three'),
      risk: 'write',
    });
    await flush();
  }

  it('runs the ticked calls in the model order and declines the others', async () => {
    const t = setup();
    await threeWrites(t);
    await t.session.approveBatch(['b3', 'b1'], ['b2']);
    const s = t.session.getState().steps;
    expect(s.b1?.status).toBe('done');
    expect(s.b2?.status).toBe('rejected');
    expect(s.b3?.status).toBe('done');
    expect(s.b1?.canUndo).toBe(true);
    expect(s.b3?.canUndo).toBe(true);
    const results = t.sent('ai:toolResult').map((c) => c.req as IpcRequest<'ai:toolResult'>);
    expect(results.map((r) => [r.callId, r.approved])).toEqual([
      ['b2', false],
      ['b1', true],
      ['b3', true],
    ]);
    // one draft per approved call, in the model's order
    const titles = t.ws.getState().issues.map((i) => i.title);
    expect(titles.slice(-2)).toEqual(['One', 'Three']);
    // each keeps its own undo
    t.session.undo('b1');
    await flush();
    expect(t.session.getState().steps.b1?.status).toBe('undone');
    expect(t.session.getState().steps.b3?.status).toBe('done');
    expect(t.ws.getState().issues.map((i) => i.title)).not.toContain('One');
  });

  it('stops at a call that fails: the rest stay waiting and can be approved one by one', async () => {
    const t = setup();
    await threeWrites(t, true);
    await t.session.approveBatch(['b1', 'b2', 'b3']);
    let s = t.session.getState().steps;
    expect(s.b1?.status).toBe('done');
    expect(s.b2?.status).toBe('error');
    expect(s.b3?.status).toBe('awaiting');
    await t.session.approve('b3');
    s = t.session.getState().steps;
    expect(s.b3?.status).toBe('done');
  });

  it('rejects all when nothing is ticked', async () => {
    const t = setup();
    await threeWrites(t);
    const before = t.ws.getState().issues.length;
    await t.session.approveBatch([], ['b1', 'b2', 'b3']);
    const s = t.session.getState().steps;
    expect([s.b1?.status, s.b2?.status, s.b3?.status]).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(t.ws.getState().issues).toHaveLength(before);
  });

  it('leaves calls that no longer wait alone', async () => {
    const t = setup();
    await threeWrites(t);
    t.session.reject('b2');
    await t.session.approveBatch(['b1', 'b2', 'b3']);
    const s = t.session.getState().steps;
    expect(s.b2?.status).toBe('rejected');
    const b2 = t.sent('ai:toolResult').filter((c) => (c.req as { callId: string }).callId === 'b2');
    expect(b2).toHaveLength(1);
  });
});

describe('view capture consent (A3)', () => {
  const capture = (callId: string): IpcEvent<'ai:event'> => ({
    type: 'tool-call',
    runId: 'id1',
    callId,
    name: 'capture_frame',
    input: {},
    risk: 'send',
  });

  it('asks before a capture while the project has not allowed it', async () => {
    const t = setup({ viewCapture: false });
    await t.session.refresh();
    expect(t.session.getState().viewCapture).toBe(false);
    await t.session.send('look');
    t.emit(capture('f1'));
    await flush();
    expect(t.session.getState().steps.f1?.status).toBe('awaiting');
    expect(t.sent('ai:toolResult')).toHaveLength(0);
  });

  it('runs a capture without a card once the project allows it, and says why', async () => {
    const t = setup({ viewCapture: true });
    await t.session.refresh();
    expect(t.session.getState().viewCapture).toBe(true);
    await t.session.send('look');
    t.emit(capture('f1'));
    await flush();
    await flush();
    const step = t.session.getState().steps.f1;
    expect(step?.status).toBe('done');
    expect(step?.note).toBe('Ran without asking: view capture is allowed for this project.');
    expect(t.sent('ai:toolResult')[0]?.req).toMatchObject({ callId: 'f1', approved: true });
  });

  it('never runs another tool without its card', async () => {
    const t = setup({ viewCapture: true });
    await t.session.refresh();
    await t.session.send('draft');
    t.emit({
      type: 'tool-call',
      runId: 'id1',
      callId: 'w1',
      name: 'create_issue_draft',
      input: { title: 'Rust', severity: 3 },
      risk: 'write',
    });
    await flush();
    expect(t.session.getState().steps.w1?.status).toBe('awaiting');
  });

  it('stores the choice for the project and turns it off again', async () => {
    const t = setup({ viewCapture: false });
    await t.session.refresh();
    expect(await t.session.setViewCapture(true)).toBe(true);
    expect(t.session.getState().viewCapture).toBe(true);
    await t.session.setViewCapture(false);
    expect(t.session.getState().viewCapture).toBe(false);
    const reqs = t.sent('ai:setViewCapture').map((c) => c.req as { allow: boolean });
    expect(reqs.map((r) => r.allow)).toEqual([true, false]);
  });

  it('"Allow for this project" stores the choice and runs the waiting capture', async () => {
    const t = setup({ viewCapture: false });
    await t.session.refresh();
    await t.session.send('look');
    t.emit(capture('f1'));
    await flush();
    await t.session.approve('f1', { allowViewCapture: true });
    expect(t.session.getState().viewCapture).toBe(true);
    expect(t.session.getState().steps.f1?.status).toBe('done');
    t.emit(capture('f2'));
    await flush();
    await flush();
    expect(t.session.getState().steps.f2?.status).toBe('done');
  });
});
