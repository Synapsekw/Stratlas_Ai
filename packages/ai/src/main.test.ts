import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { AiProvider, IpcEvent, IpcRequest } from '@aio/schema';
import { APICallError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRuntime, MESSAGES, type AgentRuntime, type AgentRuntimeHost } from './main';
import { systemPrompt } from './prompt';
import { createProviderRegistry, type ModelProvider } from './providers';
import { offlineRoutes } from './routes';
import { COMPACT_TOOLS } from './tools';

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

describe('provider errors and the connection test', () => {
  it('shows and logs the provider error text, never the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = setup({
      keys: { anthropic: 'sk-ant-api03-SECRET-0123456789' },
      doStream: () =>
        Promise.reject(
          new APICallError({
            message: 'messages.0: key sk-ant-api03-SECRET-0123456789 echoed',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 400,
            data: {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'messages.0: key sk-ant-api03-SECRET-0123456789 echoed',
              },
            },
          }),
        ),
    });
    await t.runtime.send(req());
    const end = await t.end('r1');
    expect(end).toMatchObject({
      type: 'error',
      message: expect.stringContaining(
        'Anthropic: messages.0: key [key] echoed. (HTTP 400)',
      ) as unknown,
    });
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain(
      'agent run failed: APICallError 400 invalid_request_error (Anthropic claude-sonnet-5-5): messages.0: key [key] echoed',
    );
    expect(logged).not.toContain('SECRET');
    // The SDK's own console.error of the raw error is switched off.
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('refuses the connection test when cloud AI is off or the key is missing', async () => {
    expect(await setup({ cloud: false }).runtime.testConnection({ provider: 'anthropic' })).toEqual(
      { ok: false, message: MESSAGES.cloudOff },
    );
    expect(await setup({ keys: {} }).runtime.testConnection({ provider: 'anthropic' })).toEqual({
      ok: false,
      message: 'Add an Anthropic key in Settings, AI providers.',
      model: 'claude-sonnet-5-5',
    });
    expect(await setup({}).runtime.testConnection({ provider: 'local' })).toEqual({
      ok: false,
      message: MESSAGES.localOff,
    });
  });

  it('tests a provider no route uses with its smallest model', async () => {
    const seen: string[] = [];
    const openai: ModelProvider = {
      id: 'openai',
      label: 'OpenAI',
      cloud: true,
      needsKey: true,
      languageModel: (model) => {
        seen.push(model);
        return new MockLanguageModelV4({
          modelId: model,
          doGenerate: {
            content: [{ type: 'text', text: 'OK' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: usage(5, 1),
            warnings: [],
          },
        });
      },
    };
    const t = setup({ providers: [openai] });
    expect(await t.runtime.testConnection({ provider: 'openai' })).toEqual({
      ok: true,
      message: 'OpenAI answered with gpt-6-luna: "OK".',
      model: 'gpt-6-luna',
    });
    expect(seen).toEqual(['gpt-6-luna']);
  });
});

// ---------------------------------------------------------------- M8 local agent (C7)

describe('the local agent on a small model (AI-9)', () => {
  const BASE = 'http://127.0.0.1:11434/v1';
  type Cfg = NonNullable<ReturnType<NonNullable<AgentRuntimeHost['localModel']>>>;

  function localSetup(opts: {
    cfg?: Partial<Cfg>;
    steps?: LanguageModelV4StreamPart[][];
    doStream?: MockLanguageModelV4['doStream'];
    doGenerate?: MockLanguageModelV4['doGenerate'];
    keys?: Partial<Record<AiProvider, string>>;
    cloud?: boolean;
  }) {
    const model = new MockLanguageModelV4({
      modelId: 'example-small',
      doStream: opts.doStream ?? (opts.steps ?? []).map(stream),
      ...(opts.doGenerate ? { doGenerate: opts.doGenerate } : {}),
    });
    const localKeys: (string | null)[] = [];
    const local: ModelProvider = {
      id: 'local',
      label: 'Local model',
      cloud: false,
      needsKey: false,
      optionalKey: true,
      languageModel: (_m, key) => {
        localKeys.push(key);
        return model;
      },
    };
    const cfg: Cfg = { enabled: true, baseUrl: BASE, model: 'example-small', ...opts.cfg };
    const t = setup({
      cloud: opts.cloud ?? false,
      keys: opts.keys ?? {},
      providers: [local],
      host: { routes: () => offlineRoutes('example-small'), localModel: () => cfg },
    });
    return { ...t, model, localKeys };
  }

  it('answers in text only, with a notice, on a model without tool calling', async () => {
    const t = localSetup({
      cfg: { capabilities: { tools: false, vision: false } },
      steps: [textStep('There are two layers.')],
    });
    expect(await t.runtime.status({})).toMatchObject({
      ready: true,
      reason: 'answer-only',
      message: MESSAGES.answerOnly,
      cloud: false,
    });
    await t.runtime.send(req({ messages: [{ role: 'user', content: 'Fly to the tank' }] }));
    expect((await t.end('r1')).type).toBe('done');
    const call = t.model.doStreamCalls[0];
    expect(call?.tools ?? []).toEqual([]);
    expect(JSON.stringify(call?.prompt)).toContain('cannot use the app');
    expect(text(t.events)).toBe(`${MESSAGES.answerOnlyNotice}\n\nThere are two layers.`);
    expect(t.events.some((e) => e.type === 'tool-call')).toBe(false);
  });

  it('gives the notice once per conversation', async () => {
    const t = localSetup({
      cfg: { capabilities: { tools: false, vision: false } },
      steps: [textStep('Still text.')],
    });
    await t.runtime.send(
      req({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'Again' },
        ],
      }),
    );
    await t.end('r1');
    expect(text(t.events)).toBe('Still text.');
  });

  it('falls back to answer-only when the server refuses tools', async () => {
    let n = 0;
    const t = localSetup({
      doStream: () => {
        n += 1;
        if (n === 1) {
          return Promise.reject(
            new APICallError({
              message: 'example-small does not support tools',
              url: `${BASE}/chat/completions`,
              requestBodyValues: {},
              statusCode: 400,
            }),
          );
        }
        return Promise.resolve(stream(textStep('Text only.')));
      },
    });
    await t.runtime.send(req());
    expect((await t.end('r1')).type).toBe('done');
    expect(t.model.doStreamCalls).toHaveLength(2);
    expect((t.model.doStreamCalls[0]?.tools ?? []).length).toBeGreaterThan(0);
    expect(t.model.doStreamCalls[1]?.tools ?? []).toEqual([]);
    expect(text(t.events)).toBe(`${MESSAGES.answerOnlyNotice}\n\nText only.`);
  });

  it('offers the compact tools, a compact prompt, bounded output and no parallel calls', async () => {
    const t = localSetup({
      cfg: { toolProfile: 'compact', contextTokens: 8192 },
      steps: [textStep('ok')],
    });
    await t.runtime.send(req());
    await t.end('r1');
    const call = t.model.doStreamCalls[0];
    const names = (call?.tools ?? []).map((x) => x.name);
    expect(names).toContain('fly_to');
    expect(names).not.toContain('orbit');
    const fly = call?.tools?.find((x) => x.name === 'fly_to');
    expect(fly?.type === 'function' ? fly.description : '').toBe(COMPACT_TOOLS.fly_to);
    expect(call?.maxOutputTokens).toBe(2048);
    expect(call?.providerOptions).toMatchObject({ openai: { parallelToolCalls: false } });
    const system = JSON.stringify(call?.prompt.filter((m) => m.role === 'system'));
    expect(system).toContain('one tool at a time');
    expect(system.length).toBeLessThan(systemPrompt('scene3d').length);
  });

  it('stops after six steps in the compact profile and says so', async () => {
    const t = localSetup({
      cfg: { toolProfile: 'compact' },
      doStream: () => Promise.resolve(stream(toolStep(`c${Math.random()}`, 'list_layers', {}))),
    });
    const origEmit = t.events.push.bind(t.events);
    t.events.push = (...items: AiEvent[]) => {
      const n = origEmit(...items);
      for (const e of items)
        queueMicrotask(() => {
          if (e.type === 'tool-call')
            t.runtime.toolResult({ runId: 'r1', callId: e.callId, approved: true, result: [] });
        });
      return n;
    };
    await t.runtime.send(req());
    expect((await t.end('r1')).type).toBe('done');
    expect(t.model.doStreamCalls).toHaveLength(6);
    expect(text(t.events)).toContain('I stopped after 6 steps.');
  });

  it('repairs a malformed tool call from a small model', async () => {
    const broken: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'set_view', input: "{'view': 'top',}" },
      {
        type: 'finish',
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: usage(9, 9),
      },
    ];
    const t = localSetup({ steps: [broken, textStep('Top view.')] });
    const call = respond(t.runtime, t.next, { approved: true, result: { ok: true } });
    await t.runtime.send(req());
    expect(await call).toMatchObject({ name: 'set_view', input: { view: 'top' } });
    expect((await t.end('r1')).type).toBe('done');
  });

  it('trims a long conversation into a summary and keeps the last turns', async () => {
    const t = localSetup({ cfg: { contextTokens: 2048 }, steps: [textStep('ok')] });
    const long = 'x'.repeat(5000);
    await t.runtime.send(
      req({
        messages: [
          { role: 'user', content: `Old question about the flare ${long}` },
          { role: 'assistant', content: `Old answer ${long}` },
          { role: 'user', content: 'What about tank 3?' },
        ],
      }),
    );
    await t.end('r1');
    const prompt = t.model.doStreamCalls[0]?.prompt ?? [];
    expect(prompt.filter((m) => m.role !== 'system')).toHaveLength(1);
    const system = JSON.stringify(prompt.filter((m) => m.role === 'system'));
    expect(system).toContain('Earlier in this conversation');
    expect(system).toContain('Old question about the flare');
    expect(JSON.stringify(prompt)).toContain('What about tank 3?');
  });

  it('needs vision for the vision route and detection', async () => {
    const t = localSetup({ cfg: { capabilities: { tools: true, vision: false } } });
    expect(await t.runtime.status({ task: 'vision' })).toMatchObject({
      ready: false,
      reason: 'no-route',
      message: MESSAGES.noVision,
      cloud: false,
    });
    expect(
      await t.runtime.detect({
        runId: 'd1',
        projectId: 'p1',
        classes: [{ id: 'rust', label: 'Rust' }],
        images: [{ key: 'a', dataUrl: 'data:image/png;base64,AAAA', width: 8, height: 8 }],
      }),
    ).toEqual({ ok: false, error: MESSAGES.noVision });
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('runs detection and narrative on the local model at no cost', async () => {
    const t = localSetup({
      doGenerate: () =>
        Promise.resolve({
          content: [
            {
              type: 'text',
              text: '{"images":[{"image":1,"detections":[{"class":"rust","box":[0.1,0.1,0.2,0.2],"confidence":0.8}]}]}',
            },
          ],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: usage(50, 20),
          warnings: [],
        }),
    });
    const r = await t.runtime.detect({
      runId: 'd1',
      projectId: 'p1',
      classes: [{ id: 'rust', label: 'Rust' }],
      images: [{ key: 'a', dataUrl: 'data:image/png;base64,AAAA', width: 8, height: 8 }],
    });
    expect(r).toMatchObject({ ok: true, provider: 'local', costUsd: 0 });
    expect(r.ok && r.results[0]?.detections).toHaveLength(1);
    const d = await t.runtime.draft({
      runId: 'n1',
      projectId: 'p1',
      task: 'report',
      system: 'Write.',
      prompt: 'Summarise.',
    });
    expect(d).toMatchObject({ ok: true, provider: 'local' });
  });

  it('uses the optional server key from the vault and never logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const secret = 'local-secret-key-0123';
    const t = localSetup({
      keys: { local: secret },
      doStream: () =>
        Promise.reject(
          new APICallError({
            message: `Unauthorized: Bearer ${secret}`,
            url: `${BASE}/chat/completions`,
            requestBodyValues: {},
            statusCode: 401,
          }),
        ),
    });
    await t.runtime.send(req());
    const end = await t.end('r1');
    expect(t.localKeys).toEqual([secret]);
    expect(t.getKey).toHaveBeenCalledWith('local');
    expect(t.getKey).not.toHaveBeenCalledWith('anthropic');
    expect(JSON.stringify(end)).not.toContain(secret);
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).not.toContain(secret);
    warn.mockRestore();
  });

  it('works without a key, and never calls a cloud provider when every route is local', async () => {
    const t = localSetup({ cloud: true, steps: [textStep('Local.')] });
    for (const task of ['chat', 'vision', 'report', 'extract', 'build'] as const) {
      expect(await t.runtime.status({ task })).toMatchObject({ ready: true, cloud: false });
    }
    await t.runtime.send(req());
    await t.end('r1');
    expect(t.localKeys).toEqual([null]);
    expect(t.chat.doStreamCalls).toHaveLength(0);
    expect(t.vision.doStreamCalls).toHaveLength(0);
    expect(t.seenKeys).toEqual([]);
  });

  it('says plainly when the local server is not running', async () => {
    const t = localSetup({ doStream: () => Promise.reject(new TypeError('fetch failed')) });
    await t.runtime.send(req());
    expect(await t.end('r1')).toEqual({
      type: 'error',
      runId: 'r1',
      message: MESSAGES.localDown('http://127.0.0.1:11434'),
    });
  });

  /** A model that never answers until the request is aborted, like a model still loading. */
  const hang: MockLanguageModelV4['doStream'] = ({ abortSignal }) =>
    new Promise((_, reject) => {
      abortSignal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });

  it('times out a model that gives no first token in time', async () => {
    const t = localSetup({ cfg: { timeoutMs: 1000 }, doStream: hang });
    await t.runtime.send(req());
    expect(await t.end('r1')).toEqual({
      type: 'error',
      runId: 'r1',
      message: MESSAGES.localTimeout(1000),
    });
  });

  it('stops at once when cancelled during a slow reply', async () => {
    const t = localSetup({ doStream: hang });
    await t.runtime.send(req());
    await new Promise((r) => setTimeout(r, 20));
    const at = Date.now();
    t.runtime.cancel('r1');
    expect(await t.end('r1')).toEqual({ type: 'error', runId: 'r1', message: MESSAGES.stopped });
    expect(Date.now() - at).toBeLessThan(500);
  });

  it('does not time out while the person decides on a tool', async () => {
    const t = localSetup({
      cfg: { timeoutMs: 1000 },
      steps: [
        toolStep('c1', 'create_issue_draft', { title: 'Roof corrosion', severity: 3 }),
        textStep('Drafted.'),
      ],
    });
    await t.runtime.send(req());
    const call = await t.next((e) => e.type === 'tool-call');
    await new Promise((r) => setTimeout(r, 1300));
    if (call.type !== 'tool-call') throw new Error('unreachable');
    t.runtime.toolResult({ runId: 'r1', callId: call.callId, approved: true, result: {} });
    expect((await t.end('r1')).type).toBe('done');
  });
});
