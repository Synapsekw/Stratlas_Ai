import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { AiPolicy, AiProvider, IpcEvent, IpcRequest } from '@aio/schema';
import { APICallError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRuntime, MESSAGES, type AgentRuntime, type AgentRuntimeHost } from './main';
import { systemPrompt } from './prompt';
import { createProviderRegistry, type ModelProvider } from './providers';
import { createScriptedProvider } from './scripted';
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

  it('ends a cloud run before its next step once the workstation is offline-only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let offline = false;
    const t = setup({
      steps: [
        toolStep('c1', 'create_issue_draft', { title: 'Roof corrosion', severity: 3 }),
        textStep('never'),
      ],
      host: { offlineOnly: () => offline },
    });
    await t.runtime.send(req());
    const call = await t.next((e) => e.type === 'tool-call');
    if (call.type !== 'tool-call') throw new Error('unreachable');
    // the switch is turned on while the approval waits; the person then approves
    offline = true;
    t.runtime.toolResult({ runId: 'r1', callId: call.callId, approved: true, result: {} });
    expect(await t.end('r1')).toEqual({
      type: 'error',
      runId: 'r1',
      message: MESSAGES.offlineOnly,
    });
    expect(t.chat.doStreamCalls).toHaveLength(1);
    expect(text(t.events)).toBe('');
    warn.mockRestore();
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
    // 20 steps, then one summary call without tools (this mock says nothing: the fixed line)
    expect(t.chat.doStreamCalls).toHaveLength(21);
    expect(t.chat.doStreamCalls[20]?.toolChoice).toEqual({ type: 'none' });
    expect(text(t.events)).toContain(MESSAGES.stepLimit);
    expect(MESSAGES.stepLimit).toContain('20 steps');
  });

  it('summarises what was done and what is left when the step cap is hit', async () => {
    let calls = 0;
    const t = setup({
      doStream: () => {
        calls += 1;
        return Promise.resolve(
          stream(
            calls <= 20
              ? toolStep(`c${String(calls)}`, 'list_layers', {})
              : textStep('I listed the layers 20 times. Left: compare the volumes.'),
          ),
        );
      },
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
    const last = t.chat.doStreamCalls[20];
    expect(JSON.stringify(last?.prompt)).toContain('used all the steps for this message');
    expect(text(t.events)).toContain('Left: compare the volumes.');
    expect(text(t.events)).not.toContain(MESSAGES.stepLimit);
    expect(t.events.filter((e) => e.type === 'tool-call')).toHaveLength(20);
  });

  it('sends earlier tool calls and results back to the model', async () => {
    const t = setup({ steps: [textStep('Flying to T-2.')] });
    await t.runtime.send(
      req({
        messages: [
          { role: 'user', content: 'Which tanks?' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ callId: 'toolu:1', name: 'find_places', input: { query: 'tank' } }],
          },
          {
            role: 'tool',
            results: [
              {
                callId: 'toolu:1',
                name: 'find_places',
                status: 'ok',
                output: '{"places":[{"id":"T-1"},{"id":"T-2"}]}',
              },
            ],
          },
          { role: 'assistant', content: 'T-1 and T-2.' },
          { role: 'user', content: 'Fly to the second one' },
        ],
      }),
    );
    await t.end('r1');
    const prompt = t.chat.doStreamCalls[0]?.prompt ?? [];
    expect(prompt.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    expect(prompt[2]?.content).toEqual([
      expect.objectContaining({
        type: 'tool-call',
        toolCallId: 'toolu_1',
        toolName: 'find_places',
      }),
    ]);
    expect(JSON.stringify(prompt[3])).toContain('T-2');
  });

  it('thinks and caches on Anthropic by default', async () => {
    const t = setup({ steps: [textStep('ok')] });
    await t.runtime.send(
      req({
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello.' },
          { role: 'user', content: 'How many issues?' },
        ],
      }),
    );
    await t.end('r1');
    const call = t.chat.doStreamCalls[0];
    expect(call?.reasoning).toBe('medium');
    const cached = (call?.prompt ?? []).map(
      (m) => (m.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl,
    );
    // system, the end of the older history, and the newest message of the step
    expect(cached).toEqual([
      { type: 'ephemeral' },
      undefined,
      { type: 'ephemeral' },
      { type: 'ephemeral' },
    ]);
  });

  it('neither thinks nor caches when the setting is off', async () => {
    const t = setup({ steps: [textStep('ok')], host: { agentThinking: () => false } });
    await t.runtime.send(req());
    await t.end('r1');
    const call = t.chat.doStreamCalls[0];
    expect(call?.reasoning).toBe('none');
    expect(JSON.stringify(call?.prompt)).not.toContain('cacheControl');
  });

  it('offers only the tools the project can use', async () => {
    const t = setup({ steps: [textStep('ok')] });
    await t.runtime.send(
      req({
        facts: { captures: 1, photos: false, clips: false, pointClouds: false, models: false },
      }),
    );
    await t.end('r1');
    const names = (t.chat.doStreamCalls[0]?.tools ?? []).map((x) => x.name);
    expect(names).toContain('fly_to');
    expect(names).not.toContain('compare_captures');
    expect(names).not.toContain('play_clip');
    expect(names).not.toContain('build_model');
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

  it('checks the engineer step on the vision route by default', async () => {
    expect(await setup({}).runtime.status({ task: 'engineer' })).toMatchObject({
      ready: true,
      cloud: true,
      route: { task: 'engineer', provider: 'anthropic', model: 'claude-opus-5-5' },
    });
  });

  it('refuses the engineer step on an unknown cloud model unless treated as vision', async () => {
    const routes = (treatAsVision?: boolean) => () => [
      {
        task: 'vision' as const,
        provider: 'anthropic' as const,
        model: 'claude-next-preview',
        ...(treatAsVision === undefined ? {} : { treatAsVision }),
      },
    ];
    const t = setup({ host: { routes: routes() } });
    const s = await t.runtime.status({ task: 'engineer' });
    expect(s).toMatchObject({ ready: false, reason: 'no-route', cloud: true });
    expect(s.message).toContain('"Treat as vision model"');
    // the plain vision route is not affected by the engineer check
    expect(await t.runtime.status({ task: 'vision' })).toMatchObject({ ready: true });
    expect(
      await setup({ host: { routes: routes(true) } }).runtime.status({ task: 'engineer' }),
    ).toMatchObject({ ready: true, route: { model: 'claude-next-preview' } });
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

  it('answers on the route the message names (the Model builder sends build)', async () => {
    const t = localSetup({
      cfg: { capabilities: { tools: false, vision: false } },
      steps: [textStep('Built.'), textStep('A summary.')],
    });
    // build is a tool task: a model without tools answers in text only there too
    await t.runtime.send(
      req({ task: 'build', messages: [{ role: 'user', content: 'Build tank T-102' }] }),
    );
    expect((await t.end('r1')).type).toBe('done');
    expect(text(t.events)).toBe(`${MESSAGES.answerOnlyNotice}\n\nBuilt.`);
    // the report route needs no tools, so no notice there
    const r = localSetup({
      cfg: { capabilities: { tools: false, vision: false } },
      steps: [textStep('A summary.')],
    });
    await r.runtime.send(req({ task: 'report', messages: [{ role: 'user', content: 'Sum up' }] }));
    expect((await r.end('r1')).type).toBe('done');
    expect(text(r.events)).toBe('A summary.');
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
    // six steps, then one summary call without tools (this mock says nothing: the fixed line)
    expect(t.model.doStreamCalls).toHaveLength(7);
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

  it('refuses the engineer step on a text-only local model with the reason', async () => {
    const t = localSetup({ cfg: { capabilities: { tools: true, vision: false } } });
    const s = await t.runtime.status({ task: 'engineer' });
    expect(s).toMatchObject({
      ready: false,
      reason: 'no-route',
      route: { task: 'engineer', provider: 'local', model: 'example-small' },
      cloud: false,
    });
    expect(s.message).toContain('cannot read images');
    expect(t.model.doGenerateCalls).toHaveLength(0);
    expect(t.model.doStreamCalls).toHaveLength(0);
  });

  it('allows the engineer step on a local model the probe found with vision', async () => {
    const t = localSetup({ cfg: { capabilities: { tools: false, vision: true } } });
    expect(await t.runtime.status({ task: 'engineer' })).toMatchObject({
      ready: true,
      route: { task: 'engineer', provider: 'local' },
      cloud: false,
    });
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

describe('custom requests on cloud models (ai:ask)', () => {
  const IMG = 'data:image/png;base64,AAAA';
  const askReq = (over: Partial<IpcRequest<'ai:ask'>> = {}): IpcRequest<'ai:ask'> => ({
    runId: 'ask-1',
    projectId: 'p1',
    backend: { kind: 'cloud', provider: 'anthropic', model: 'claude-sonnet-5-5' },
    kind: 'find',
    prompt: 'Find all gauges.',
    fields: [],
    images: [{ key: 'photo:p1', dataUrl: IMG, width: 1000, height: 500 }],
    ...over,
  });

  function askSetup(host: Partial<AgentRuntimeHost> = {}, more: ModelProvider[] = []) {
    const onGenerate = vi.fn();
    const recordUsage = vi.fn();
    const runtime = createAgentRuntime(
      {
        getKey: () => Promise.resolve(null),
        cloudAllowed: () => true,
        emit: () => undefined,
        recordUsage,
        ...host,
      },
      {
        providers: createProviderRegistry([
          createScriptedProvider('anthropic', true, { onGenerate }),
          ...more,
        ]),
        maxRetries: 0,
      },
    );
    return { runtime, onGenerate, recordUsage };
  }

  it('answers a find through the scripted provider and meters the usage', async () => {
    const t = askSetup();
    const r = await t.runtime.ask(askReq());
    expect(r).toMatchObject({ ok: true, provider: 'anthropic', model: 'claude-sonnet-5-5' });
    if (r.ok) expect(r.items).toHaveLength(2);
    expect(t.recordUsage).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ provider: 'anthropic', inputTokens: 1200 }),
    );
  });

  it('refuses a local backend: those run in the app', async () => {
    const t = askSetup();
    expect(await t.runtime.ask(askReq({ backend: { kind: 'local' } }))).toEqual({
      ok: false,
      error: 'Local requests run in the app.',
    });
    expect(t.onGenerate).not.toHaveBeenCalled();
  });

  it('refuses before any call while offline-only', async () => {
    const t = askSetup({ offlineOnly: () => true });
    expect(await t.runtime.ask(askReq())).toEqual({ ok: false, error: MESSAGES.offlineOnly });
    expect(t.onGenerate).not.toHaveBeenCalled();
  });

  it('refuses before any call with cloud AI off', async () => {
    const t = askSetup({ cloudAllowed: () => false });
    expect(await t.runtime.ask(askReq())).toEqual({ ok: false, error: MESSAGES.cloudOff });
    expect(t.onGenerate).not.toHaveBeenCalled();
  });

  it('refuses before any call under the forbid policy', async () => {
    const t = askSetup({ policy: () => Promise.resolve('forbid') });
    expect(await t.runtime.ask(askReq())).toEqual({
      ok: false,
      code: 'forbidden',
      error: MESSAGES.forbidden,
    });
    expect(t.onGenerate).not.toHaveBeenCalled();
  });

  it('ask refuses a cloud request once the project forbids it, read from disk per request', async () => {
    let onDisk: AiPolicy = 'allow';
    const policy = vi.fn(() => Promise.resolve(onDisk));
    const t = askSetup({ policy });
    expect((await t.runtime.ask(askReq({ runId: 'a' }))).ok).toBe(true);
    onDisk = 'forbid';
    expect(await t.runtime.ask(askReq({ runId: 'b' }))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(policy).toHaveBeenCalledTimes(2);
    expect(t.onGenerate).toHaveBeenCalledTimes(1);
  });

  it('refuses a provider that needs a key it does not have', async () => {
    const t = askSetup({}, [
      { ...createScriptedProvider('openai'), label: 'OpenAI', needsKey: true },
    ]);
    const r = await t.runtime.ask(
      askReq({ backend: { kind: 'cloud', provider: 'openai', model: 'gpt-6-luna' } }),
    );
    expect(r).toMatchObject({ ok: false });
    expect(t.onGenerate).not.toHaveBeenCalled();
  });

  it('answers busy for a run id already at work, and cancel stops a run', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const t = askSetup({
      policy: async () => {
        await held;
        return 'allow';
      },
    });
    const first = t.runtime.ask(askReq());
    expect(await t.runtime.ask(askReq())).toMatchObject({
      ok: false,
      code: 'busy',
      error: MESSAGES.busy,
    });
    t.runtime.cancel('ask-1');
    release();
    expect(await first).toEqual({ ok: false, error: MESSAGES.stopped, stopped: true });
  });

  describe('askStatus', () => {
    const openai = (needsKey: boolean): ModelProvider => ({
      ...createScriptedProvider('openai'),
      label: 'OpenAI',
      needsKey,
    });

    it('lists the providers that are keyless or keyed', async () => {
      const keyed = askSetup({ getKey: (p) => Promise.resolve(p === 'openai' ? 'k' : null) }, [
        openai(true),
      ]);
      expect(await keyed.runtime.askStatus('p1')).toEqual({
        cloud: { usable: true, providers: ['anthropic', 'openai'] },
        keepLocal: false,
      });
      const keyless = askSetup({}, [openai(true)]);
      expect((await keyless.runtime.askStatus('p1')).cloud.providers).toEqual(['anthropic']);
    });

    it('says why the cloud cannot be used, offline-only first', async () => {
      const all = askSetup({
        offlineOnly: () => true,
        cloudAllowed: () => false,
        policy: () => Promise.resolve('forbid'),
      });
      expect(await all.runtime.askStatus('p1')).toMatchObject({
        cloud: { usable: false, reason: 'offline-only', message: MESSAGES.offlineOnly },
        keepLocal: true,
      });
      const off = askSetup({ cloudAllowed: () => false, policy: () => Promise.resolve('forbid') });
      expect((await off.runtime.askStatus('p1')).cloud).toMatchObject({
        usable: false,
        reason: 'cloud-off',
      });
      const kept = askSetup({ policy: () => Promise.resolve('forbid') });
      expect(await kept.runtime.askStatus('p1')).toMatchObject({
        cloud: { usable: false, reason: 'forbidden', message: MESSAGES.forbidden },
        keepLocal: true,
      });
    });
  });
});
