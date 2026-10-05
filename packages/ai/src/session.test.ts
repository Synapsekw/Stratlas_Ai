import type {
  AioBridge,
  Conversation,
  IpcChannel,
  IpcEvent,
  IpcRequest,
  IpcResponse,
} from '@aio/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RendererToolContext } from './renderer-tools';
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
        : { ready: true, route, cloud: opts.cloud ?? true };
  const bridge: AioBridge = {
    invoke: <C extends IpcChannel>(channel: C, req: IpcRequest<C>) => {
      calls.push({ channel, req });
      const answer: Partial<Record<IpcChannel, unknown>> = {
        'ai:status': status,
        'ai:project': {
          alwaysAllow: opts.alwaysAllow ?? true,
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

function setup(opts: BridgeOpts = {}) {
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
    now: () => new Date('2026-10-04T10:00:00Z'),
    saveDelayMs: 0,
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
