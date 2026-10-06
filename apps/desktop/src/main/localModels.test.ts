import type { LocalModelSettings } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerLocalModelsIpc, type LocalModelsIpcDeps } from './localModels';
import { collectHandlers } from './notYet';

const ROOT = 'http://127.0.0.1:1234';
const KEY = 'local-secret-key-0123';

/** One OpenAI chat completion: a call of `ready`, or a text answer. */
function completion(reply: { tool: true } | { text: string }) {
  const message =
    'tool' in reply
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'ready', arguments: '{"ok":true}' },
            },
          ],
        }
      : { role: 'assistant', content: reply.text };
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'example-a',
    choices: [{ index: 0, message, finish_reason: 'tool' in reply ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * An LM Studio-like server: two models, `example-a` with tool calling and no vision. Records
 * every request.
 */
function fakeServer() {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url === `${ROOT}/v1/models`) {
      return Promise.resolve(
        json({ object: 'list', data: [{ id: 'example-a' }, { id: 'example-b' }] }),
      );
    }
    if (url === `${ROOT}/api/v0/models`) {
      return Promise.resolve(
        json({
          data: [
            { id: 'example-a', type: 'llm', max_context_length: 8192, capabilities: ['tool_use'] },
            { id: 'example-b', type: 'llm', max_context_length: 4096 },
          ],
        }),
      );
    }
    if (url === `${ROOT}/v1/chat/completions`) {
      const body = JSON.parse(init?.body as string) as {
        tools?: unknown[];
        messages: { content: unknown }[];
      };
      const image = JSON.stringify(body.messages).includes('image_url');
      if (image) return Promise.resolve(json({ error: { message: 'no vision' } }, 400));
      return Promise.resolve(json(completion(body.tools ? { tool: true } : { text: 'Hi' })));
    }
    return Promise.reject(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    );
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, spy: fetch };
}

function setup(over: Partial<Omit<LocalModelsIpcDeps, 'handle'>> = {}) {
  const server = fakeServer();
  const cfg: LocalModelSettings = { enabled: true, baseUrl: `${ROOT}/v1`, model: 'example-a' };
  const ipc = collectHandlers((handle) => {
    registerLocalModelsIpc({
      handle,
      localModel: () => cfg,
      cloudAllowed: () => false,
      getKey: () => Promise.resolve(null),
      fetch: server.fetch,
      ...over,
    });
  });
  return { ipc, server };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('local model IPC (C7)', () => {
  it('registers discovery and the probe', () => {
    expect(setup().ipc.channels()).toEqual(['ai:localModels', 'ai:localProbe']);
  });

  it('lists the models of the server in Settings, with their badges', async () => {
    const { ipc, server } = setup();
    expect(await ipc.call('ai:localModels', {})).toEqual({
      ok: true,
      server: { kind: 'openai-compatible' },
      models: [
        { id: 'example-a', contextTokens: 8192, tools: true, vision: false },
        { id: 'example-b', contextTokens: 4096, vision: false },
      ],
    });
    for (const c of server.calls) expect(c.url.startsWith(ROOT)).toBe(true);
  });

  it('looks at the address the person typed', async () => {
    const { ipc, server } = setup();
    const r = await ipc.call('ai:localModels', { baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(r).toEqual({
      ok: false,
      error:
        'Nothing answers at http://127.0.0.1:11434. Start Ollama, LM Studio or the llama.cpp server, then try again.',
    });
    expect(server.calls.every((c) => c.url.startsWith('http://127.0.0.1:11434/'))).toBe(true);
  });

  it('refuses an address on another machine while cloud AI is off, without a request', async () => {
    const { ipc, server } = setup();
    for (const r of [
      await ipc.call('ai:localModels', { baseUrl: 'http://192.168.1.20:11434/v1' }),
      await ipc.call('ai:localProbe', { model: 'm', baseUrl: 'http://192.168.1.20:11434/v1' }),
    ]) {
      expect(r).toEqual({
        ok: false,
        error:
          'http://192.168.1.20:11434 is on another machine, so data would leave this one. Turn on cloud AI in Settings, Privacy, to use it.',
      });
    }
    expect(server.spy).not.toHaveBeenCalled();
  });

  it('allows an address on another machine once cloud AI is on', async () => {
    const { ipc, server } = setup({ cloudAllowed: () => true });
    await ipc.call('ai:localModels', { baseUrl: 'http://192.168.1.20:11434/v1' });
    expect(server.spy).toHaveBeenCalled();
  });

  it('tests a model: tools yes, vision no, its context and the time to answer', async () => {
    const { ipc } = setup();
    const r = await ipc.call('ai:localProbe', { model: 'example-a' });
    expect(r).toMatchObject({ ok: true, tools: true, vision: false, contextTokens: 8192 });
    expect(r.ok && r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the optional server key and never logs it', async () => {
    const log = [vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'log')];
    for (const s of log) s.mockImplementation(() => undefined);
    const { ipc, server } = setup({ getKey: () => Promise.resolve(KEY) });
    await ipc.call('ai:localModels', {});
    const probe = await ipc.call('ai:localProbe', { model: 'example-a' });
    expect(server.calls.length).toBeGreaterThan(2);
    for (const c of server.calls) expect(c.auth).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(probe)).not.toContain(KEY);
    const logged = log.flatMap((s) => s.mock.calls.map((c) => c.join(' '))).join('\n');
    expect(logged).not.toContain(KEY);
  });

  it('remembers the kind of server that answered, without its address', async () => {
    const seen: unknown[] = [];
    const { ipc } = setup({ remember: (s) => seen.push(s) });
    await ipc.call('ai:localModels', { baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(seen).toEqual([]);
    await ipc.call('ai:localModels', {});
    await ipc.call('ai:localProbe', { model: 'example-a' });
    expect(seen).toEqual([
      { kind: 'openai-compatible', loopback: true, at: expect.any(String) as string },
      { kind: 'openai-compatible', loopback: true, at: expect.any(String) as string },
    ]);
    expect(JSON.stringify(seen)).not.toContain('127.0.0.1');
  });

  it('remembers the version an Ollama server reports', async () => {
    const seen: unknown[] = [];
    const ollama = (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/version')) return Promise.resolve(json({ version: '0.12.3' }));
      if (url.endsWith('/api/tags')) return Promise.resolve(json({ models: [{ name: 'qwen3' }] }));
      if (url.endsWith('/api/show'))
        return Promise.resolve(json({ capabilities: ['completion', 'tools'] }));
      return Promise.reject(new TypeError('fetch failed'));
    };
    const { ipc } = setup({
      fetch: ollama,
      remember: (s) => seen.push(s),
    });
    expect(await ipc.call('ai:localModels', {})).toMatchObject({ ok: true });
    expect(seen).toEqual([
      { kind: 'ollama', version: '0.12.3', loopback: true, at: expect.any(String) as string },
    ]);
  });

  it('works without a key', async () => {
    const { ipc, server } = setup();
    await ipc.call('ai:localModels', {});
    for (const c of server.calls) expect(c.auth).toBeNull();
  });
});
