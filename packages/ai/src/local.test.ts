import type { LanguageModelV4CallOptions, LanguageModelV4Content } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import {
  COMPACT_MAX_STEPS,
  discoverLocalModels,
  isToolsUnsupported,
  localGate,
  openAiBase,
  outputBudget,
  parseLmStudioModels,
  parseOllamaShow,
  parseOllamaTags,
  parseOpenAiModels,
  probeLocalModel,
  serverRoot,
  trimConversation,
} from './local';
import {
  isLoopbackUrl,
  isOfflineAgent,
  LOCAL_SERVERS,
  OFFLINE_TASKS,
  offlineRoutes,
  restoreRoutes,
} from './routes';

// Recorded shapes (trimmed) of the three server families; the model names are made up.
const OLLAMA_TAGS = {
  models: [
    {
      name: 'example-tools:7b',
      model: 'example-tools:7b',
      size: 4_683_087_332,
      details: { family: 'llama', parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
    },
    {
      name: 'example-embed:latest',
      model: 'example-embed:latest',
      size: 274_302_450,
      details: { family: 'bert', quantization_level: 'F16' },
    },
    {
      name: 'example-vision:11b',
      model: 'example-vision:11b',
      size: 7_901_829_417,
      details: { family: 'mllama', quantization_level: 'Q4_K_M' },
    },
  ],
};
const OLLAMA_SHOW: Record<string, unknown> = {
  'example-tools:7b': {
    model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 },
    capabilities: ['completion', 'tools'],
  },
  'example-embed:latest': {
    model_info: { 'general.architecture': 'bert', 'bert.context_length': 512 },
    capabilities: ['embedding'],
  },
  'example-vision:11b': {
    model_info: { 'general.architecture': 'mllama', 'mllama.context_length': 131072 },
    capabilities: ['completion', 'vision'],
  },
};
const OPENAI_MODELS = {
  object: 'list',
  data: [
    { id: 'example-a', object: 'model', owned_by: 'organization_owner' },
    { id: 'example-embedder', object: 'model', owned_by: 'organization_owner' },
  ],
};
const LLAMACPP_MODELS = {
  object: 'list',
  data: [
    {
      id: 'example-b.gguf',
      object: 'model',
      owned_by: 'llamacpp',
      meta: { n_ctx_train: 8192, size: 4_000_000_000 },
    },
  ],
};
const LMSTUDIO_V0 = {
  object: 'list',
  data: [
    {
      id: 'example-a',
      type: 'vlm',
      arch: 'qwen2_vl',
      quantization: 'Q4_K_M',
      max_context_length: 32768,
      capabilities: ['tool_use'],
    },
    { id: 'example-embedder', type: 'embeddings', max_context_length: 2048 },
  ],
};

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch that answers from a table of `METHOD url` routes and records every call. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const route = routes[`${init?.method ?? 'GET'} ${url}`];
    if (!route) {
      return Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
      );
    }
    return Promise.resolve(route(init));
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('local server addresses', () => {
  it('finds the server root and the OpenAI base of an address', () => {
    expect(serverRoot('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(serverRoot('http://localhost:11434/v1/')).toBe('http://localhost:11434');
    expect(serverRoot('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
    expect(openAiBase('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/v1');
    expect(openAiBase('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234/v1');
  });

  it('knows loopback from another machine', () => {
    expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:1234')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.20:11434')).toBe(false);
    expect(isLoopbackUrl('https://api.example.com/v1')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
    // names that only look local: each is resolved by DNS or is another host altogether
    for (const remote of [
      'http://ollama.localhost:11434/v1',
      'http://localhost.example.com:11434',
      'http://127.0.0.1.example.com:11434',
      'http://localhost@example.com:11434',
      'http://0.0.0.0:11434',
    ])
      expect(isLoopbackUrl(remote), remote).toBe(false);
  });

  it('lists the default ports of Ollama, LM Studio and the llama.cpp server, on this machine', () => {
    expect(LOCAL_SERVERS.map((s) => new URL(s.baseUrl).port)).toEqual(['11434', '1234', '8080']);
    for (const s of LOCAL_SERVERS) expect(isLoopbackUrl(s.baseUrl)).toBe(true);
  });
});

describe('discovery parsers', () => {
  it('reads Ollama tags with size, family and quantisation', () => {
    expect(parseOllamaTags(OLLAMA_TAGS)[0]).toEqual({
      id: 'example-tools:7b',
      name: 'example-tools:7b',
      sizeBytes: 4_683_087_332,
      family: 'llama',
      quantization: 'Q4_K_M',
    });
    expect(parseOllamaTags({ nope: true })).toEqual([]);
  });

  it('reads context, tools and vision from Ollama show', () => {
    expect(parseOllamaShow(OLLAMA_SHOW['example-tools:7b'])).toEqual({
      contextTokens: 32768,
      tools: true,
      vision: false,
      completion: true,
    });
    expect(parseOllamaShow(OLLAMA_SHOW['example-embed:latest'])).toMatchObject({
      completion: false,
    });
    expect(parseOllamaShow({})).toEqual({});
  });

  it('reads OpenAI-compatible model lists, with the llama.cpp context when given', () => {
    expect(parseOpenAiModels(OPENAI_MODELS).map((m) => m.id)).toEqual([
      'example-a',
      'example-embedder',
    ]);
    expect(parseOpenAiModels(LLAMACPP_MODELS)[0]).toEqual({
      id: 'example-b.gguf',
      contextTokens: 8192,
      sizeBytes: 4_000_000_000,
    });
  });

  it('reads the LM Studio model details and marks embedders', () => {
    const extra = parseLmStudioModels(LMSTUDIO_V0);
    expect(extra.get('example-a')).toEqual({
      contextTokens: 32768,
      tools: true,
      vision: true,
      quantization: 'Q4_K_M',
      family: 'qwen2_vl',
    });
    expect(extra.get('example-embedder')).toEqual({ embedding: true, contextTokens: 2048 });
  });
});

describe('discoverLocalModels', () => {
  it('finds an Ollama server, its chat models and their badges', async () => {
    const root = 'http://127.0.0.1:11434';
    const { fetch, calls } = fakeFetch({
      [`GET ${root}/api/version`]: () => json({ version: '0.12.3' }),
      [`GET ${root}/api/tags`]: () => json(OLLAMA_TAGS),
      [`POST ${root}/api/show`]: (init) => {
        const { model } = JSON.parse(init?.body as string) as { model: string };
        return json(OLLAMA_SHOW[model] ?? {}, OLLAMA_SHOW[model] ? 200 : 404);
      },
    });
    const r = await discoverLocalModels({ baseUrl: `${root}/v1`, fetch });
    expect(r).toEqual({
      ok: true,
      server: { kind: 'ollama', version: '0.12.3' },
      models: [
        expect.objectContaining({
          id: 'example-tools:7b',
          contextTokens: 32768,
          tools: true,
          vision: false,
        }),
        expect.objectContaining({ id: 'example-vision:11b', tools: false, vision: true }),
      ],
    });
    for (const c of calls) expect(c.url.startsWith(root)).toBe(true);
  });

  it('falls back to the OpenAI-compatible list and adds LM Studio details', async () => {
    const root = 'http://127.0.0.1:1234';
    const { fetch } = fakeFetch({
      [`GET ${root}/api/version`]: () => json({ error: 'Unexpected endpoint or method.' }),
      [`GET ${root}/v1/models`]: () => json(OPENAI_MODELS),
      [`GET ${root}/api/v0/models`]: () => json(LMSTUDIO_V0),
    });
    const r = await discoverLocalModels({ baseUrl: `${root}/v1`, fetch });
    expect(r).toEqual({
      ok: true,
      server: { kind: 'openai-compatible' },
      models: [
        {
          id: 'example-a',
          contextTokens: 32768,
          tools: true,
          vision: true,
          quantization: 'Q4_K_M',
          family: 'qwen2_vl',
        },
      ],
    });
  });

  it('reads a llama.cpp server without LM Studio details', async () => {
    const root = 'http://127.0.0.1:8080';
    const { fetch } = fakeFetch({
      [`GET ${root}/api/version`]: () => new Response('Not found', { status: 404 }),
      [`GET ${root}/v1/models`]: () => json(LLAMACPP_MODELS),
      [`GET ${root}/api/v0/models`]: () => new Response('Not found', { status: 404 }),
    });
    const r = await discoverLocalModels({ baseUrl: root, fetch });
    expect(r).toMatchObject({ ok: true, models: [{ id: 'example-b.gguf', contextTokens: 8192 }] });
  });

  it('sends the optional server key as a bearer token', async () => {
    const root = 'http://127.0.0.1:1234';
    const { fetch, calls } = fakeFetch({
      [`GET ${root}/v1/models`]: () => json(OPENAI_MODELS),
    });
    await discoverLocalModels({ baseUrl: root, fetch, key: 'local-secret-123' });
    const auth = calls.map((c) => new Headers(c.init?.headers).get('authorization'));
    expect(auth.every((a) => a === 'Bearer local-secret-123')).toBe(true);
  });

  it('says plainly when nothing answers, and never names the key', async () => {
    const { fetch } = fakeFetch({});
    const r = await discoverLocalModels({ baseUrl: 'http://localhost:11434/v1', fetch });
    expect(r).toEqual({
      ok: false,
      error:
        'Nothing answers at http://localhost:11434. Start Ollama, LM Studio or the llama.cpp server, then try again.',
    });
  });

  it('asks for the key when the server refuses without one', async () => {
    const root = 'http://127.0.0.1:1234';
    const { fetch } = fakeFetch({
      [`GET ${root}/v1/models`]: () => json({ error: 'Unauthorized' }, 401),
    });
    const r = await discoverLocalModels({ baseUrl: root, fetch, key: 'local-secret-123' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(
        'The server at http://127.0.0.1:1234 did not accept the server key. Check it under Server key.',
      );
      expect(r.error).not.toContain('local-secret-123');
    }
  });

  it('reports a server that lists nothing to chat with', async () => {
    const root = 'http://127.0.0.1:1234';
    const { fetch } = fakeFetch({
      [`GET ${root}/v1/models`]: () => json({ object: 'list', data: [] }),
    });
    expect(await discoverLocalModels({ baseUrl: root, fetch })).toEqual({
      ok: false,
      error:
        'The server at http://127.0.0.1:1234 has no models yet. Download a model with tool calling in Ollama or LM Studio, then try again.',
    });
  });
});

// ---------------------------------------------------------------- probe

const finish = (reason: 'stop' | 'tool-calls') => ({
  finishReason: { unified: reason, raw: reason },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
  warnings: [],
});

/** A model that answers a tool request with a call (or text), and images with `imageReply`. */
function probeModel(opts: {
  tools: boolean | 'refuse';
  /** The answer to the image request; undefined: the server refuses images. */
  imageReply?: string;
  delayMs?: number;
}) {
  const seen: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    modelId: 'example',
    doGenerate: async (call) => {
      seen.push(call);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const hasImage = call.prompt.some(
        (m) => m.role === 'user' && m.content.some((p) => p.type === 'file'),
      );
      if (hasImage) {
        if (opts.imageReply === undefined) {
          throw new APICallError({
            message: 'model does not support image input',
            url: 'http://127.0.0.1/v1/chat/completions',
            requestBodyValues: {},
            statusCode: 400,
          });
        }
        return {
          content: [{ type: 'text', text: opts.imageReply }] as LanguageModelV4Content[],
          ...finish('stop'),
        };
      }
      if (opts.tools === 'refuse') {
        throw new APICallError({
          message: 'registry.ollama.ai/library/example does not support tools',
          url: 'http://127.0.0.1/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 400,
          responseBody: JSON.stringify({ error: { message: 'example does not support tools' } }),
        });
      }
      if (opts.tools) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'ready',
              input: JSON.stringify({ ok: true }),
            },
          ] as LanguageModelV4Content[],
          ...finish('tool-calls'),
        };
      }
      return {
        content: [{ type: 'text', text: 'I am ready.' }] as LanguageModelV4Content[],
        ...finish('stop'),
      };
    },
  });
  return { model, seen };
}

describe('probeLocalModel', () => {
  it('finds tool calling and vision, and measures the latency', async () => {
    let t = 1000;
    const { model, seen } = probeModel({ tools: true, imageReply: 'Red.' });
    const r = await probeLocalModel({
      model,
      now: () => (t += 250),
    });
    expect(r).toEqual({ ok: true, tools: true, vision: true, latencyMs: 250 });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.tools?.map((x) => x.name)).toEqual(['ready']);
  });

  it('reports no tools when the server refuses them, and no vision without an answer', async () => {
    const { model } = probeModel({ tools: 'refuse' });
    expect(await probeLocalModel({ model })).toMatchObject({
      ok: true,
      tools: false,
      vision: false,
    });
  });

  it('reports no tools when the model answers in text instead', async () => {
    const { model } = probeModel({ tools: false, imageReply: 'I cannot see images.' });
    expect(await probeLocalModel({ model })).toMatchObject({
      ok: true,
      tools: false,
      vision: false,
    });
  });

  it('skips the image request when the server says the model has no vision', async () => {
    const { model, seen } = probeModel({ tools: true, imageReply: 'Red.' });
    expect(await probeLocalModel({ model, claimsVision: false })).toMatchObject({ vision: false });
    expect(seen).toHaveLength(1);
  });

  it('fails with a clear message when the model does not answer in time', async () => {
    const { model } = probeModel({ tools: true, delayMs: 200 });
    const r = await probeLocalModel({ model, timeoutMs: 20 });
    expect(r).toEqual({
      ok: false,
      error: 'The model did not answer within 1 s. It may still be loading: try again.',
    });
  });
});

describe('isToolsUnsupported', () => {
  it('spots the 400 a server gives for a model without tools', () => {
    const e = new APICallError({
      message: 'Bad Request',
      url: 'x',
      requestBodyValues: {},
      statusCode: 400,
      responseBody: '{"error":{"message":"example does not support tools"}}',
    });
    expect(isToolsUnsupported(e)).toBe(true);
    expect(isToolsUnsupported(new Error('tools'))).toBe(false);
  });
});

// ---------------------------------------------------------------- runtime helpers

describe('route capability checks', () => {
  const base = { enabled: true, baseUrl: 'http://localhost:11434/v1', model: 'm' };

  it('turns a chat route on a model without tools into answer-only', () => {
    expect(localGate({ ...base, capabilities: { tools: false, vision: false } }, 'chat')).toBe(
      'answer-only',
    );
    expect(localGate({ ...base, capabilities: { tools: true, vision: false } }, 'chat')).toBe(null);
  });

  it('needs vision for the vision route', () => {
    expect(localGate({ ...base, capabilities: { tools: true, vision: false } }, 'vision')).toBe(
      'no-vision',
    );
    expect(localGate({ ...base, capabilities: { tools: true, vision: true } }, 'vision')).toBe(
      null,
    );
  });

  it('trusts a model that was never tested', () => {
    expect(localGate(base, 'chat')).toBe(null);
    expect(localGate(base, 'vision')).toBe(null);
    expect(localGate(undefined, 'chat')).toBe(null);
  });
});

describe('small-model budgets', () => {
  it('uses six steps in the compact profile', () => {
    expect(COMPACT_MAX_STEPS).toBe(6);
  });

  it('bounds output tokens by the context window', () => {
    expect(outputBudget(undefined)).toBe(16_000);
    expect(outputBudget(4096)).toBe(1024);
    expect(outputBudget(1000)).toBe(512);
    expect(outputBudget(1_000_000)).toBe(16_000);
  });
});

describe('trimConversation', () => {
  const long = (n: number) => 'x'.repeat(n);

  it('keeps everything when it fits', () => {
    const msgs = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi' },
      { role: 'user' as const, content: 'Show tank 3' },
    ];
    expect(trimConversation(msgs, 8192)).toEqual({ messages: msgs, summary: null });
    expect(trimConversation(msgs, undefined)).toEqual({ messages: msgs, summary: null });
  });

  it('drops the oldest turns into a short summary and keeps the last turns', () => {
    const msgs = [
      { role: 'user' as const, content: `First question about the flare ${long(4000)}` },
      { role: 'assistant' as const, content: `First answer ${long(4000)}` },
      { role: 'user' as const, content: 'Second question' },
      { role: 'assistant' as const, content: 'Second answer' },
      { role: 'user' as const, content: 'Third question' },
    ];
    const r = trimConversation(msgs, 2048);
    expect(r.messages.map((m) => m.content)).toEqual([
      'Second question',
      'Second answer',
      'Third question',
    ]);
    expect(r.summary).toMatch(/^The person asked: First question about the flare/);
    expect(r.summary?.length).toBeLessThan(1200);
  });

  it('always keeps the newest message, even when it alone is over budget', () => {
    const msgs = [
      { role: 'user' as const, content: 'Old' },
      { role: 'assistant' as const, content: 'Old answer' },
      { role: 'user' as const, content: long(20_000) },
    ];
    const r = trimConversation(msgs, 1024);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.content).toHaveLength(20_000);
  });
});

describe('offline agent preset', () => {
  it('routes chat, vision, report, extract and build to the local model', () => {
    const routes = offlineRoutes('example-tools:7b');
    expect(routes.map((r) => r.task)).toEqual(OFFLINE_TASKS);
    expect(routes.every((r) => r.provider === 'local' && r.model === 'example-tools:7b')).toBe(
      true,
    );
    expect(isOfflineAgent(routes)).toBe(true);
    expect(isOfflineAgent([{ task: 'chat', provider: 'anthropic', model: 'x' }])).toBe(false);
  });

  it('goes back to the routes before, or the defaults', () => {
    const before = [{ task: 'chat' as const, provider: 'openai' as const, model: 'gpt-6-luna' }];
    expect(restoreRoutes(JSON.stringify(before))).toEqual(before);
    expect(restoreRoutes(null)[0]?.provider).toBe('anthropic');
    expect(restoreRoutes('not json')[0]?.provider).toBe('anthropic');
    expect(restoreRoutes(JSON.stringify(offlineRoutes('m')))[0]?.provider).toBe('anthropic');
  });
});
