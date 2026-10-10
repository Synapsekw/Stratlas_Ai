/**
 * Offline-only workstation: no cloud AI call is made, a model on this machine stays available.
 * The real providers run here against a `fetch` that records every request (no network), so a
 * request that would have left the machine shows up in `seen`.
 */
import type { AiProvider, AiTask, IpcEvent, IpcRequest, LocalModelSettings } from '@aio/schema';
import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { describeError, OfflineOnlyError } from './errors';
import { createAgentRuntime, MESSAGES } from './main';
import { builtInProviders, createProviderRegistry, localProvider } from './providers';

type AiEvent = IpcEvent<'ai:event'>;

const KEY = 'sk-test-NOT-A-REAL-KEY-0123456789';
const TASKS: AiTask[] = ['chat', 'vision', 'report', 'extract', 'build'];
const CLOUD = [
  ['anthropic', 'claude-sonnet-5-5', 'https://api.anthropic.com/'],
  ['openai', 'gpt-6-luna', 'https://api.openai.com/'],
  ['google', 'gemini-3.5-flash', 'https://generativelanguage.googleapis.com/'],
] as const;
const REMOTE = 'http://10.0.0.5:11434/v1';
const LOOPBACK = 'http://127.0.0.1:11434/v1';

/** A `fetch` that records where each request would have gone and answers with an error. */
function recorder() {
  const seen: string[] = [];
  const fetch: typeof globalThis.fetch = (input) => {
    seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: 'fake: request recorded' } }), {
        status: 418,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, seen };
}

function setup(o: {
  provider: AiProvider;
  model: string;
  offlineOnly: () => boolean;
  localModel?: LocalModelSettings;
}) {
  const net = recorder();
  const events: AiEvent[] = [];
  const waiting = new Map<string, (e: AiEvent) => void>();
  const getKey = vi.fn(() => Promise.resolve<string | null>(KEY));
  const runtime = createAgentRuntime(
    {
      getKey,
      // cloud AI is switched on throughout: offline-only alone must hold every call back
      cloudAllowed: () => true,
      offlineOnly: o.offlineOnly,
      routes: () => TASKS.map((task) => ({ task, provider: o.provider, model: o.model })),
      localModel: () => o.localModel,
      emit: (e) => {
        events.push(e);
        if (e.type === 'done' || e.type === 'error') waiting.get(e.runId)?.(e);
      },
    },
    {
      providers: createProviderRegistry(
        builtInProviders({ fetch: net.fetch, offlineOnly: o.offlineOnly }),
      ),
      maxRetries: 0,
    },
  );
  const ended = (runId: string) =>
    new Promise<AiEvent>((resolve) => {
      const done = events.find(
        (e) => e.runId === runId && (e.type === 'done' || e.type === 'error'),
      );
      if (done) resolve(done);
      else waiting.set(runId, resolve);
    });
  return { runtime, net, getKey, ended };
}

const send = (runId = 'r1'): IpcRequest<'ai:send'> => ({
  runId,
  window: 'scene3d',
  context: { selection: null },
  messages: [{ role: 'user', content: 'How many issues are open?' }],
});

const detect: IpcRequest<'ai:detect'> = {
  runId: 'd1',
  projectId: 'p1',
  classes: [{ id: 'rust', label: 'Rust' }],
  images: [{ key: 'a', dataUrl: 'data:image/png;base64,AAAA', width: 8, height: 8 }],
};

const draft: IpcRequest<'ai:draftText'> = {
  runId: 'n1',
  projectId: 'p1',
  task: 'report',
  system: 'Write.',
  prompt: 'Summarise.',
};

describe.each(CLOUD)('offline-only workstation: %s', (provider, model, origin) => {
  it('refuses every call with the reason, reads no key and sends nothing', async () => {
    const t = setup({ provider, model, offlineOnly: () => true });
    expect(await t.runtime.send(send())).toEqual({ ok: false, error: MESSAGES.offlineOnly });
    expect(await t.runtime.detect(detect)).toEqual({ ok: false, error: MESSAGES.offlineOnly });
    expect(await t.runtime.draft(draft)).toEqual({ ok: false, error: MESSAGES.offlineOnly });
    expect(await t.runtime.testConnection({ provider })).toEqual({
      ok: false,
      message: MESSAGES.offlineOnly,
    });
    for (const task of TASKS) {
      expect(await t.runtime.status({ task })).toMatchObject({
        ready: false,
        reason: 'offline-only',
        message: MESSAGES.offlineOnly,
        cloud: true,
      });
    }
    expect(t.net.seen).toEqual([]);
    expect(t.getKey).not.toHaveBeenCalled();
  });

  it('calls the provider on each of those paths with offline-only off', async () => {
    const t = setup({ provider, model, offlineOnly: () => false });
    await t.runtime.send(send());
    await t.ended('r1');
    await t.runtime.detect(detect);
    await t.runtime.draft(draft);
    await t.runtime.testConnection({ provider });
    expect(t.net.seen).toHaveLength(4);
    for (const url of t.net.seen) expect(url.startsWith(origin)).toBe(true);
  });

  it('holds back the very next call once offline-only is turned on, and lets it go once off', async () => {
    let offline = false;
    const t = setup({ provider, model, offlineOnly: () => offline });
    await t.runtime.send(send('r1'));
    await t.ended('r1');
    expect(t.net.seen).toHaveLength(1);
    offline = true;
    expect(await t.runtime.send(send('r2'))).toEqual({ ok: false, error: MESSAGES.offlineOnly });
    expect(t.net.seen).toHaveLength(1);
    offline = false;
    expect(await t.runtime.send(send('r3'))).toEqual({ ok: true });
    await t.ended('r3');
    expect(t.net.seen).toHaveLength(2);
  });

  it('refuses the request itself, whatever asked for it, and never tries again', async () => {
    const net = recorder();
    let offline = true;
    const p = builtInProviders({ fetch: net.fetch, offlineOnly: () => offline }).find(
      (x) => x.id === provider,
    );
    if (!p) throw new Error(`no built-in provider ${provider}`);
    // straight to the provider with the default retries: past every gate of the runtime
    const ask = () => generateText({ model: p.languageModel(model, KEY), prompt: 'Reply OK.' });
    const failure = await ask().then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(OfflineOnlyError);
    expect(describeError(failure, { label: p.label, secrets: [KEY] }).message).toBe(
      MESSAGES.offlineOnly,
    );
    expect(net.seen).toEqual([]);
    offline = false;
    await ask().catch(() => undefined);
    expect(net.seen.length).toBeGreaterThan(0);
  });
});

describe('offline-only workstation: the local model', () => {
  const local = (baseUrl: string): LocalModelSettings => ({ enabled: true, baseUrl, model: 'm' });

  it('keeps a model on this machine available', async () => {
    const t = setup({
      provider: 'local',
      model: 'm',
      offlineOnly: () => true,
      localModel: local(LOOPBACK),
    });
    expect(await t.runtime.status({})).toMatchObject({
      ready: true,
      cloud: false,
      route: { provider: 'local' },
    });
    // the request itself is not held back either
    const net = recorder();
    const p = localProvider({ baseUrl: LOOPBACK }, { fetch: net.fetch, offlineOnly: () => true });
    expect(p.cloud).toBe(false);
    await generateText({ model: p.languageModel('m', null), prompt: 'Hi', maxRetries: 0 }).catch(
      () => undefined,
    );
    expect(net.seen).toEqual(['http://127.0.0.1:11434/v1/chat/completions']);
  });

  it.each([REMOTE, 'http://ollama.localhost:11434/v1', 'https://models.example.com/v1'])(
    'treats a "local" model at %s as cloud and refuses it',
    async (baseUrl) => {
      const t = setup({
        provider: 'local',
        model: 'm',
        offlineOnly: () => true,
        localModel: local(baseUrl),
      });
      expect(await t.runtime.status({})).toMatchObject({
        ready: false,
        reason: 'offline-only',
        cloud: true,
      });
      expect(await t.runtime.send(send())).toEqual({ ok: false, error: MESSAGES.offlineOnly });
      expect(await t.runtime.testConnection({ provider: 'local' })).toEqual({
        ok: false,
        message: MESSAGES.offlineOnly,
      });
      const net = recorder();
      const p = localProvider({ baseUrl }, { fetch: net.fetch, offlineOnly: () => true });
      expect(p.cloud).toBe(true);
      const failure = await generateText({ model: p.languageModel('m', null), prompt: 'Hi' }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(OfflineOnlyError);
      expect(net.seen).toEqual([]);
    },
  );
});
