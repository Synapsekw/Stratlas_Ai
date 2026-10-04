/**
 * The requests the agent sends, checked offline against the documented constraints of each
 * provider API by a fake `fetch` (no network). The Anthropic fake answers like the Messages API:
 * the same validation errors, the same error bodies, and the workspace check that the installed
 * app hit on 2026-10-04 (an organisation key without `anthropic-workspace-id`).
 */
import type { AiProvider, IpcEvent, IpcRequest, WindowKind } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from './main';
import { builtInProviders, createProviderRegistry } from './providers';
import type { ModelRoute } from './routes';

const KEY = 'sk-ant-api03-NOT-A-REAL-KEY-0123456789abcdef';
const WINDOWS: WindowKind[] = [
  'scene3d',
  'map',
  'video',
  'photo',
  'pointcloud',
  'report',
  'issues',
];
/** Current Anthropic models (claude-api reference, 2026-09-25) and their output limits. */
const ANTHROPIC_MODELS: Record<string, number> = {
  'claude-fable-5-1': 128_000,
  'claude-opus-5-5': 128_000,
  'claude-sonnet-5-5': 128_000,
  'claude-haiku-4-5': 64_000,
  'claude-haiku-4-5-20251001': 64_000,
};
/** Models that reject sampling parameters and explicit thinking budgets. */
const NO_SAMPLING = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']);
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface Fake {
  fetch: typeof fetch;
  seen: Captured[];
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const anthropicError = (status: number, type: string, message: string) =>
  json(status, { type: 'error', error: { type, message } }, { 'request-id': 'req_test' });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the Messages API rejects, in the order it reports it. Null when the request is valid. */
function anthropicProblem(c: Captured, orgKey: boolean): Response | null {
  const h = c.headers;
  if (h['x-api-key'] !== KEY)
    return anthropicError(401, 'authentication_error', 'invalid x-api-key');
  if (h['anthropic-version'] !== '2023-06-01') {
    return anthropicError(400, 'invalid_request_error', 'anthropic-version: invalid');
  }
  if (orgKey && !/^wrkspc_[A-Za-z0-9]+$/.test(h['anthropic-workspace-id'] ?? '')) {
    return anthropicError(
      400,
      'invalid_request_error',
      'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.',
    );
  }
  const b = c.body;
  const bad = (m: string) => anthropicError(400, 'invalid_request_error', m);
  const model = String(b.model);
  const limit = ANTHROPIC_MODELS[model];
  if (limit === undefined) return anthropicError(404, 'not_found_error', `model: ${model}`);
  if (typeof b.max_tokens !== 'number' || b.max_tokens < 1)
    return bad('max_tokens: Field required');
  if (b.max_tokens > limit) return bad(`max_tokens: ${b.max_tokens} > ${limit}`);
  if (NO_SAMPLING.has(model)) {
    for (const p of ['temperature', 'top_p', 'top_k']) {
      if (p in b) return bad(`${p}: not supported for this model`);
    }
    const thinking = b.thinking as { type?: string } | undefined;
    if (thinking && thinking.type !== 'adaptive') return bad('thinking.type: must be adaptive');
  }
  const choice = b.tool_choice as { type?: string } | undefined;
  if (choice && choice.type !== 'auto' && choice.type !== 'none') {
    return bad('tool_choice: type "tool" and "any" are not supported for this model.');
  }
  if (b.system !== undefined) {
    if (!Array.isArray(b.system)) return bad('system: expected array or string');
    for (const block of b.system) {
      if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') {
        return bad('system: blocks must be text');
      }
    }
  }
  const tools = (b.tools ?? []) as unknown[];
  const names = new Set<string>();
  for (const [i, t] of tools.entries()) {
    if (!isObject(t)) return bad(`tools.${i}: invalid`);
    const name = String(t.name);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
      return bad(`tools.${i}.name: String should match pattern`);
    if (names.has(name)) return bad(`tools: Tool names must be unique.`);
    names.add(name);
    if (typeof t.description !== 'string' || t.description.trim() === '') {
      return bad(`tools.${i}.description: must be non-empty`);
    }
    const schema = t.input_schema;
    if (!isObject(schema) || schema.type !== 'object') {
      return bad(`tools.${i}.input_schema.type: Input should be 'object'`);
    }
    for (const k of ['oneOf', 'anyOf', 'allOf']) {
      if (k in schema)
        return bad(`tools.${i}.custom.input_schema: ${k} is not supported at the top level`);
    }
  }
  const messages = b.messages as unknown[];
  if (!Array.isArray(messages) || messages.length === 0)
    return bad('messages: at least one message is required');
  const first = messages[0];
  if (!isObject(first) || first.role !== 'user')
    return bad('messages.0.role: first message must use the "user" role');
  for (const [i, m] of messages.entries()) {
    if (!isObject(m) || (m.role !== 'user' && m.role !== 'assistant'))
      return bad(`messages.${i}.role: invalid`);
    const content = typeof m.content === 'string' ? [] : (m.content as unknown[]);
    for (const [j, block] of content.entries()) {
      if (!isObject(block)) return bad(`messages.${i}.content.${j}: invalid`);
      if (block.type === 'text' && (typeof block.text !== 'string' || block.text === '')) {
        return bad(`messages.${i}.content.${j}.text: text content blocks must be non-empty`);
      }
      if (block.type === 'image') {
        const src = block.source as Record<string, unknown> | undefined;
        if (
          src?.type !== 'base64' ||
          !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
            String(src.media_type),
          ) ||
          typeof src.data !== 'string' ||
          src.data.startsWith('data:')
        ) {
          return bad(`messages.${i}.content.${j}.image.source: invalid`);
        }
      } else if (block.type !== 'text') {
        return bad(`messages.${i}.content.${j}.type: unexpected ${String(block.type)}`);
      }
    }
  }
  return null;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

function sse(events: Record<string, unknown>[]): Response {
  const text = events
    .map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function anthropicReply(model: string, stream: boolean): Response {
  const usage = { input_tokens: 12, output_tokens: 2 };
  if (!stream) {
    return json(200, {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    });
  }
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ]);
}

/** A fake of api.anthropic.com/v1/messages. `orgKey`: the key is not scoped to a workspace. */
function fakeAnthropic(orgKey = false): Fake {
  const seen: Captured[] = [];
  const f = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const c: Captured = {
      url: urlOf(input),
      headers,
      body: bodyOf(init),
    };
    seen.push(c);
    if (c.url !== 'https://api.anthropic.com/v1/messages') {
      return Promise.resolve(anthropicError(404, 'not_found_error', 'Not Found'));
    }
    return Promise.resolve(
      anthropicProblem(c, orgKey) ?? anthropicReply(String(c.body.model), c.body.stream === true),
    );
  };
  return { fetch: f, seen };
}

/** OpenAI Responses and Gemini generateContent: function names and parameter schemas. */
function fakeOther(): Fake {
  const seen: Captured[] = [];
  const f = (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Captured = {
      url: urlOf(input),
      headers: {},
      body: bodyOf(init),
    };
    seen.push(c);
    return Promise.resolve(json(418, { error: { message: 'fake: request recorded' } }));
  };
  return { fetch: f, seen };
}

type AiEvent = IpcEvent<'ai:event'>;

function runtime(fake: Fake, route: ModelRoute, opts: { workspace?: string } = {}) {
  const events: AiEvent[] = [];
  let finish: (e: AiEvent) => void = () => undefined;
  const ended = new Promise<AiEvent>((resolve) => (finish = resolve));
  const rt = createAgentRuntime(
    {
      getKey: (p: AiProvider) => Promise.resolve(p === 'local' ? null : KEY),
      cloudAllowed: () => true,
      routes: () => [route, { ...route, task: 'vision' }],
      emit: (e) => {
        events.push(e);
        if (e.type === 'done' || e.type === 'error') finish(e);
      },
    },
    {
      providers: createProviderRegistry(
        builtInProviders({ fetch: fake.fetch, anthropicWorkspaceId: () => opts.workspace }),
      ),
      maxRetries: 0,
    },
  );
  return { rt, events, ended };
}

const send = (over: Partial<IpcRequest<'ai:send'>> = {}): IpcRequest<'ai:send'> => ({
  runId: 'r1',
  window: 'scene3d',
  context: { selection: null },
  messages: [
    { role: 'user', content: 'How many issues are open?' },
    { role: 'assistant', content: 'Three.' },
    { role: 'user', content: 'Show the first.' },
  ],
  ...over,
});

const anthropicRoute: ModelRoute = {
  task: 'chat',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
};

describe('Anthropic request', () => {
  it.each(WINDOWS)('is valid for the %s window and streams the answer', async (window) => {
    const fake = fakeAnthropic();
    const t = runtime(fake, anthropicRoute);
    expect(await t.rt.send(send({ window }))).toEqual({ ok: true });
    expect(await t.ended).toEqual({ type: 'done', runId: 'r1' });
    const req = fake.seen[0];
    expect(req?.headers['anthropic-workspace-id']).toBeUndefined();
    expect(req?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      stream: true,
      max_tokens: 16_000,
    });
  });

  it('sends an attached frame as a base64 image block', async () => {
    const fake = fakeAnthropic();
    const t = runtime(fake, { ...anthropicRoute, model: 'claude-opus-5-5' });
    await t.rt.send(send({ image: PNG }));
    expect(await t.ended).toEqual({ type: 'done', runId: 'r1' });
    const last = (fake.seen[0]?.body.messages as { content: { type: string }[] }[]).at(-1);
    expect(last?.content.map((b) => b.type)).toEqual(['text', 'text', 'image']);
  });

  it('reproduces the installed app failure: an organisation key without a workspace', async () => {
    const fake = fakeAnthropic(true);
    const t = runtime(fake, anthropicRoute);
    await t.rt.send(send());
    const end = await t.ended;
    expect(end.type).toBe('error');
    if (end.type !== 'error') return;
    expect(end.message).toContain('Anthropic: This API key is not scoped to a workspace');
    expect(end.message).toContain(
      'Enter the workspace ID under Anthropic in Settings, AI providers',
    );
    expect(end.message).not.toContain(KEY);
  });

  it('sends the workspace ID from Settings, and the same key then works', async () => {
    const fake = fakeAnthropic(true);
    const t = runtime(fake, anthropicRoute, { workspace: 'wrkspc_01TestWorkspace' });
    await t.rt.send(send());
    expect(await t.ended).toEqual({ type: 'done', runId: 'r1' });
    expect(fake.seen[0]?.headers['anthropic-workspace-id']).toBe('wrkspc_01TestWorkspace');
  });

  it('names a model the API does not know', async () => {
    const fake = fakeAnthropic();
    const t = runtime(fake, { ...anthropicRoute, model: 'claude-sonnet-5.5' });
    await t.rt.send(send());
    const end = await t.ended;
    expect(end).toMatchObject({
      type: 'error',
      message:
        'Anthropic: model not found: claude-sonnet-5.5. (HTTP 404) Choose another model in Settings, AI providers.',
    });
  });

  it('tests the connection with one small request and reports the result', async () => {
    const fake = fakeAnthropic(true);
    const failing = runtime(fake, anthropicRoute);
    const r1 = await failing.rt.testConnection({ provider: 'anthropic' });
    expect(r1).toMatchObject({ ok: false, status: 400, model: 'claude-sonnet-5-5' });
    expect(r1.message).toContain('not scoped to a workspace');
    const fixed = runtime(fake, anthropicRoute, { workspace: 'wrkspc_01TestWorkspace' });
    const r2 = await fixed.rt.testConnection({ provider: 'anthropic' });
    expect(r2).toEqual({
      ok: true,
      message: 'Anthropic answered with claude-sonnet-5-5: "OK".',
      model: 'claude-sonnet-5-5',
    });
    const body = fake.seen.at(-1)?.body;
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 256 });
    expect(body?.tools).toBeUndefined();
    expect(body?.stream).toBeUndefined();
  });
});

describe('OpenAI and Gemini requests', () => {
  const OPENAI_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
  const GEMINI_NAME = /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/;

  it.each(WINDOWS)('declares valid functions for the %s window', async (window) => {
    for (const [provider, model] of [
      ['openai', 'gpt-6-luna'],
      ['google', 'gemini-3.5-flash'],
    ] as const) {
      const fake = fakeOther();
      const t = runtime(fake, { task: 'chat', provider, model });
      await t.rt.send(send({ window }));
      const end = await t.ended;
      // The provider's own error text reaches the panel.
      expect(end).toMatchObject({ type: 'error' });
      if (end.type === 'error') expect(end.message).toContain('fake: request recorded');
      const body = fake.seen[0]?.body ?? {};
      if (provider === 'openai') {
        expect(fake.seen[0]?.url).toBe('https://api.openai.com/v1/responses');
        expect(body).not.toHaveProperty('temperature');
        for (const tool of body.tools as {
          name: string;
          description: string;
          parameters: Record<string, unknown>;
        }[]) {
          expect(tool.name).toMatch(OPENAI_NAME);
          expect(tool.description.trim()).not.toBe('');
          expect(tool.parameters.type).toBe('object');
          for (const k of ['oneOf', 'anyOf', 'allOf', 'not', 'enum'])
            expect(tool.parameters).not.toHaveProperty(k);
        }
      } else {
        expect(fake.seen[0]?.url).toBe(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse',
        );
        const decls =
          (
            body.tools as {
              functionDeclarations: {
                name: string;
                description: string;
                parametersJsonSchema: Record<string, unknown>;
              }[];
            }[]
          )[0]?.functionDeclarations ?? [];
        expect(decls.length).toBeGreaterThan(0);
        for (const d of decls) {
          expect(d.name).toMatch(GEMINI_NAME);
          expect(d.description.trim()).not.toBe('');
          expect(d.parametersJsonSchema.type).toBe('object');
        }
      }
    }
  });
});
