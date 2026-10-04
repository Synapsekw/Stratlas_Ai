import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { AiProvider, IpcEvent, IpcRequest } from '@aio/schema';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRuntime, MESSAGES, type AgentRuntime, type AgentRuntimeHost } from './main';
import { createProviderRegistry, type ModelProvider } from './providers';

type AiEvent = IpcEvent<'ai:event'>;

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage: usage(100, 20) },
  ];
}

function toolStep(callId: string, name: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: callId, toolName: name, input: JSON.stringify(input) },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_use' },
      usage: usage(100, 10),
    },
  ];
}

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: convertArrayToReadableStream(parts),
});

function setup(opts: {
  steps?: LanguageModelV4StreamPart[][];
  doStream?: MockLanguageModelV4['doStream'];
  cloud?: boolean;
  keys?: Partial<Record<AiProvider, string>>;
  host?: Partial<AgentRuntimeHost>;
  providers?: ModelProvider[];
}) {
  const chat = new MockLanguageModelV4({
    modelId: 'claude-sonnet-5-5',
    doStream: opts.doStream ?? (opts.steps ?? []).map(stream),
  });
  const vision = new MockLanguageModelV4({
    modelId: 'claude-opus-5-5',
    doStream: [stream(textStep('I see a tank roof.'))],
  });
  const seenKeys: (string | null)[] = [];
  const anthropic: ModelProvider = {
    id: 'anthropic',
    label: 'Anthropic',
    cloud: true,
    needsKey: true,
    languageModel: (model, key) => {
      seenKeys.push(key);
      return model === 'claude-opus-5-5' ? vision : chat;
    },
  };
  const events: AiEvent[] = [];
  const waiters: { pred: (e: AiEvent) => boolean; resolve: (e: AiEvent) => void }[] = [];
  const getKey = vi.fn((p: AiProvider) =>
    Promise.resolve(opts.keys ? (opts.keys[p] ?? null) : 'test-key-not-real'),
  );
  const host: AgentRuntimeHost = {
    getKey,
    cloudAllowed: () => opts.cloud ?? true,
    emit: (e) => {
      events.push(e);
      for (const w of [...waiters]) {
        if (w.pred(e)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(e);
        }
      }
    },
    ...opts.host,
  };
  const runtime = createAgentRuntime(host, {
    providers: createProviderRegistry([anthropic, ...(opts.providers ?? [])]),
    maxRetries: 0,
  });
  const next = (pred: (e: AiEvent) => boolean) =>
    new Promise<AiEvent>((resolve) => {
      const found = events.find(pred);
      if (found) resolve(found);
      else waiters.push({ pred, resolve });
    });
  const end = (runId: string) =>
    next((e) => e.runId === runId && (e.type === 'done' || e.type === 'error'));
  return { runtime, events, next, end, chat, vision, getKey, seenKeys };
}

const req = (over: Partial<IpcRequest<'ai:send'>> = {}): IpcRequest<'ai:send'> => ({
  runId: 'r1',
  window: 'scene3d',
  context: { selection: { kind: 'asset', id: '20-T-0002' }, nowUtc: '2023-02-21T15:11:26Z' },
  messages: [{ role: 'user', content: 'How many issues are open?' }],
  ...over,
});

const text = (events: AiEvent[]) => events.map((e) => (e.type === 'text' ? e.delta : '')).join('');

/** Answer every tool call like the renderer would, with `answer`. */
function respond(
  runtime: AgentRuntime,
  next: (pred: (e: AiEvent) => boolean) => Promise<AiEvent>,
  answer: Omit<IpcRequest<'ai:toolResult'>, 'runId' | 'callId'>,
) {
  return next((e) => e.type === 'tool-call').then((e) => {
    if (e.type !== 'tool-call') throw new Error('unreachable');
    runtime.toolResult({ runId: e.runId, callId: e.callId, ...answer });
    return e;
  });
}

describe('agent runtime', () => {
  it('refuses to call out with cloud AI off', async () => {
    const t = setup({ cloud: false, steps: [textStep('hi')] });
    const res = await t.runtime.send(req());
    expect(res).toEqual({ ok: false, error: MESSAGES.cloudOff });
    expect(t.getKey).not.toHaveBeenCalled();
    expect(t.chat.doStreamCalls).toHaveLength(0);
    expect(t.events).toHaveLength(0);
  });

  it('names the provider when its key is missing', async () => {
    const t = setup({ keys: {}, steps: [textStep('hi')] });
    const res = await t.runtime.send(req());
    expect(res).toEqual({ ok: false, error: 'Add an Anthropic key in Settings, AI providers.' });
    expect(t.chat.doStreamCalls).toHaveLength(0);
  });

  it('streams text, reports usage with cost and finishes', async () => {
    const t = setup({ steps: [textStep('Seven issues are open.')] });
    expect(await t.runtime.send(req())).toEqual({ ok: true });
    expect((await t.end('r1')).type).toBe('done');
    expect(text(t.events)).toBe('Seven issues are open.');
    const u = t.events.find((e) => e.type === 'usage');
    expect(u).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(u?.type === 'usage' ? u.costUsd : undefined).toBeCloseTo(0.0004);
    expect(t.seenKeys).toEqual(['test-key-not-real']);
  });

  it('gives the model the window context and the tools for that window', async () => {
    const t = setup({ steps: [textStep('ok')] });
    await t.runtime.send(req({ window: 'issues' }));
    await t.end('r1');
    const call = t.chat.doStreamCalls[0];
    const names = (call?.tools ?? []).map((x) => x.name);
    expect(names).toContain('list_issues');
    expect(names).not.toContain('set_layer_visible');
    const prompt = JSON.stringify(call?.prompt);
    expect(prompt).toContain('20-T-0002');
    expect(prompt).toContain('How many issues are open?');
  });

  it('routes to the vision model when an image is attached', async () => {
    const t = setup({ steps: [textStep('chat')] });
    await t.runtime.send(req({ image: 'data:image/jpeg;base64,/9j/4AAQ' }));
    await t.end('r1');
    expect(t.vision.doStreamCalls).toHaveLength(1);
    expect(t.chat.doStreamCalls).toHaveLength(0);
    expect(text(t.events)).toBe('I see a tank roof.');
  });

  it('runs a read tool through the renderer and continues with its result', async () => {
    const t = setup({
      steps: [toolStep('c1', 'list_issues', { status: 'draft' }), textStep('Two drafts.')],
    });
    const call = respond(t.runtime, t.next, { approved: true, result: { total: 2 } });
    await t.runtime.send(req());
    expect(await call).toMatchObject({
      type: 'tool-call',
      name: 'list_issues',
      risk: 'read',
      input: { status: 'draft', limit: 50 },
    });
    expect((await t.end('r1')).type).toBe('done');
    expect(JSON.stringify(t.chat.doStreamCalls[1]?.prompt)).toContain('"total":2');
    expect(text(t.events)).toBe('Two drafts.');
  });

  it('waits for approval of a write tool, then continues', async () => {
    const t = setup({
      steps: [
        toolStep('c1', 'create_issue_draft', { title: 'Roof corrosion', severity: 3 }),
        textStep('Drafted D01.'),
      ],
    });
    await t.runtime.send(req());
    const call = await t.next((e) => e.type === 'tool-call');
    expect(call).toMatchObject({ risk: 'write', name: 'create_issue_draft' });
    // Nothing moves until the person decides.
    await new Promise((r) => setTimeout(r, 20));
    expect(t.chat.doStreamCalls).toHaveLength(1);
    if (call.type !== 'tool-call') throw new Error('unreachable');
    t.runtime.toolResult({
      runId: 'r1',
      callId: call.callId,
      approved: true,
      result: { code: 'D01' },
    });
    expect((await t.end('r1')).type).toBe('done');
    expect(JSON.stringify(t.chat.doStreamCalls[1]?.prompt)).toContain('D01');
  });

  it('tells the model when the person rejects a tool', async () => {
    const t = setup({
      steps: [
        toolStep('c1', 'create_issue_draft', { title: 'Roof corrosion', severity: 3 }),
        textStep('Understood, nothing was created.'),
      ],
    });
    const call = respond(t.runtime, t.next, { approved: false });
    await t.runtime.send(req());
    await call;
    expect((await t.end('r1')).type).toBe('done');
    expect(JSON.stringify(t.chat.doStreamCalls[1]?.prompt)).toContain(MESSAGES.declined);
  });

  it('passes renderer errors to the model as fixed text', async () => {
    const t = setup({
      steps: [toolStep('c1', 'fly_to', { target: { kind: 'asset', id: 'nope' } }), textStep('ok')],
    });
    const call = respond(t.runtime, t.next, { approved: true, error: 'No asset "nope" here.' });
    await t.runtime.send(req());
    await call;
    await t.end('r1');
    expect(JSON.stringify(t.chat.doStreamCalls[1]?.prompt)).toContain('No asset \\"nope\\" here.');
  });

  it('stops when cancelled while waiting for approval', async () => {
    const t = setup({
      steps: [
        toolStep('c1', 'create_issue_draft', { title: 'Roof corrosion', severity: 3 }),
        textStep('never'),
      ],
    });
    await t.runtime.send(req());
    await t.next((e) => e.type === 'tool-call');
    t.runtime.cancel('r1');
    expect(await t.end('r1')).toEqual({ type: 'error', runId: 'r1', message: MESSAGES.stopped });
    expect(t.chat.doStreamCalls).toHaveLength(1);
    expect(text(t.events)).toBe('');
  });

  it('turns a network failure into a clear message', async () => {
    const t = setup({
      doStream: () => Promise.reject(new TypeError('fetch failed')),
    });
    await t.runtime.send(req());
    expect(await t.end('r1')).toEqual({
      type: 'error',
      runId: 'r1',
      message: 'Cannot reach Anthropic. Check the internet connection, or keep working offline.',
    });
  });

  it('stops after the step limit and says so', async () => {
    const t = setup({
      doStream: () => Promise.resolve(stream(toolStep(`c${Math.random()}`, 'list_layers', {}))),
    });
    const answer = (e: AiEvent) => {
      if (e.type === 'tool-call')
        t.runtime.toolResult({ runId: 'r1', callId: e.callId, approved: true, result: [] });
    };
    const origEmit = t.events.push.bind(t.events);
    t.events.push = (...items: AiEvent[]) => {
      const n = origEmit(...items);
      for (const e of items)
        queueMicrotask(() => {
          answer(e);
        });
      return n;
    };
    await t.runtime.send(req());
    expect((await t.end('r1')).type).toBe('done');
    expect(t.chat.doStreamCalls).toHaveLength(8);
    expect(text(t.events)).toContain(MESSAGES.stepLimit);
  });

  it('rejects a second run with the same id while the first is busy', async () => {
    const t = setup({
      steps: [toolStep('c1', 'create_issue_draft', { title: 'x', severity: 1 })],
    });
    await t.runtime.send(req());
    await t.next((e) => e.type === 'tool-call');
    expect(await t.runtime.send(req())).toEqual({ ok: false, error: MESSAGES.busy });
    t.runtime.cancel('r1');
    await t.end('r1');
  });

  it('meters usage to the project with provider and model', async () => {
    const recorded: unknown[] = [];
    const t = setup({
      steps: [textStep('ok')],
      host: {
        recordUsage: (projectId, u) => {
          recorded.push({ projectId, ...u });
        },
      },
    });
    await t.runtime.send(req({ projectId: 'p1' }));
    await t.end('r1');
    const u = t.events.find((e) => e.type === 'usage');
    expect(u).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(recorded).toEqual([
      expect.objectContaining({ projectId: 'p1', provider: 'anthropic', inputTokens: 100 }),
    ]);
  });
});

describe('project AI policy and the local model', () => {
  const localModel = new MockLanguageModelV4({
    modelId: 'llama3.2',
    doStream: [stream(textStep('Local answer.'))],
  });
  const local: ModelProvider = {
    id: 'local',
    label: 'Local model',
    cloud: false,
    needsKey: false,
    languageModel: () => localModel,
  };
  const localRoutes = () => [
    { task: 'chat' as const, provider: 'local' as const, model: 'llama3.2' },
  ];

  it('refuses cloud providers for a project whose package forbids them', async () => {
    const t = setup({ steps: [textStep('hi')], host: { policy: () => Promise.resolve('forbid') } });
    expect(await t.runtime.send(req({ projectId: 'p1' }))).toEqual({
      ok: false,
      error: MESSAGES.forbidden,
    });
    expect(t.chat.doStreamCalls).toHaveLength(0);
    expect(await t.runtime.status({ projectId: 'p1' })).toMatchObject({
      ready: false,
      reason: 'forbidden',
      cloud: true,
    });
  });

  it('allows a local model with cloud AI off and under a forbid policy', async () => {
    const t = setup({
      cloud: false,
      keys: {},
      providers: [local],
      host: { routes: localRoutes, policy: () => Promise.resolve('forbid') },
    });
    expect(await t.runtime.status({ projectId: 'p1' })).toMatchObject({
      ready: true,
      cloud: false,
      route: { provider: 'local' },
    });
    expect(await t.runtime.send(req({ projectId: 'p1' }))).toEqual({ ok: true });
    expect((await t.end('r1')).type).toBe('done');
    expect(text(t.events)).toBe('Local answer.');
    const u = t.events.find((e) => e.type === 'usage');
    expect(u).toMatchObject({ provider: 'local', costUsd: 0 });
  });

  it('builds the local provider from settings and keeps it off by default', async () => {
    const t = setup({ cloud: false, host: { routes: localRoutes } });
    expect(await t.runtime.status({})).toMatchObject({ ready: false, reason: 'local-off' });
    const on = setup({
      cloud: false,
      host: {
        routes: localRoutes,
        localModel: () => ({ enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'x' }),
      },
    });
    expect(await on.runtime.status({})).toMatchObject({ ready: true, cloud: false });
  });

  it('treats a local endpoint on another machine as cloud', async () => {
    const t = setup({
      cloud: false,
      host: {
        routes: localRoutes,
        localModel: () => ({ enabled: true, baseUrl: 'http://10.0.0.5:11434/v1', model: 'x' }),
      },
    });
    expect(await t.runtime.status({})).toMatchObject({
      ready: false,
      reason: 'cloud-off',
      cloud: true,
    });
  });

  it('reports cloud off and a missing key in the status', async () => {
    expect(await setup({ cloud: false }).runtime.status({})).toMatchObject({
      ready: false,
      reason: 'cloud-off',
    });
    expect(await setup({ keys: {} }).runtime.status({})).toMatchObject({
      ready: false,
      reason: 'no-key',
      message: 'Add an Anthropic key in Settings, AI providers.',
    });
    expect(await setup({}).runtime.status({})).toMatchObject({
      ready: true,
      cloud: true,
      route: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    });
  });
});
