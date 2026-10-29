import type { HardwareCheck, IpcRequest } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { createLocalAsk, type LocalAskDeps } from './ask';
import type { AnalyticsPack } from './pack';

type Req = IpcRequest<'ai:ask'>;

const KEY = 'k'.repeat(32);
const state = {
  url: 'http://127.0.0.1:5555',
  pid: 1,
  apiKey: KEY,
  modelSha256: 'a'.repeat(64),
  startedAt: '2026-10-29T00:00:00.000Z',
};
const pack = (id: string): AnalyticsPack =>
  ({
    version: '0.2.0',
    dir: 'D:/pack',
    manifest: { model: { id, sha256: 'b'.repeat(64) } },
    server: 's',
    gguf: 'g',
    mmproj: 'm',
  }) as unknown as AnalyticsPack;

const img = (key: string, label?: string) => ({
  key,
  dataUrl: 'data:image/jpeg;base64,AAAA',
  width: 1000,
  height: 500,
  ...(label ? { label } : {}),
});
const findReq = (over: Partial<Req> = {}): Req => ({
  runId: 'r1',
  projectId: 'p1',
  backend: { kind: 'local' },
  kind: 'find',
  prompt: 'Find all gauges.',
  fields: [],
  images: [img('a')],
  ...over,
});

const reply = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop', ...extra }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
    { status: 200 },
  );

function setup(o: {
  model?: string;
  replies?: (() => Response | Promise<Response>)[];
  gpuBusy?: string | null;
  hw?: HardwareCheck;
  env?: Record<string, string | undefined>;
  pack?: AnalyticsPack | null;
}) {
  const replies = [...(o.replies ?? [])];
  const fetch = vi.fn<(u: string, i: RequestInit) => Promise<Response>>(() => {
    const next = replies.shift();
    return Promise.resolve(next ? next() : reply('[]'));
  });
  const release = vi.fn();
  const server = {
    ensure: vi.fn(() => Promise.resolve({ ok: true as const, state })),
    attach: vi.fn(() => Promise.resolve(state)),
    serves: vi.fn(() => false),
    lease: vi.fn(() => release),
  };
  const idleIfUnused = vi.fn();
  const findPack = vi.fn(() =>
    Promise.resolve(o.pack === undefined ? pack(o.model ?? 'qwen3.5-9b-q4_k_m') : o.pack),
  );
  const d: LocalAskDeps = {
    env: o.env ?? {},
    findPack,
    unusable: () => Promise.resolve([{ version: '0.1.0', reason: 'Too old for this app.' }]),
    hardware: () =>
      Promise.resolve(o.hw ?? { ok: true, gpu: 'x', gpuIndex: 0, totalMb: 16000, freeMb: 12000 }),
    server,
    gpuBusy: () => o.gpuBusy ?? null,
    idleIfUnused,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => 0,
  };
  return { ask: createLocalAsk(d), fetch, release, server, idleIfUnused, findPack };
}

const body = (f: ReturnType<typeof vi.fn>, n = 0) =>
  JSON.parse((f.mock.calls[n]?.[1] as { body: string }).body) as Record<string, unknown>;

describe('local ask', () => {
  it('posts the key, the images then the prompt, and thinking off for Qwen3.5', async () => {
    const t = setup({ replies: [() => reply('[]')] });
    const r = await t.ask.run(findReq({ images: [img('a', 'May')] }));
    expect(r.ok).toBe(true);
    const [url, init] = t.fetch.mock.calls[0] ?? ['', {}];
    expect(url).toBe('http://127.0.0.1:5555/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const b = body(t.fetch);
    expect(b.temperature).toBe(0);
    expect(b.max_tokens).toBe(2048);
    expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
    const msgs = b.messages as { role: string; content: { type: string; text?: string }[] }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content[0]).toEqual({ type: 'text', text: 'Image 1 (May):' });
    expect(msgs[0]?.content[1]?.type).toBe('image_url');
    expect(msgs[0]?.content[2]?.text).toContain('Find all gauges.');
  });

  it('leaves thinking out for Qwen2.5', async () => {
    const t = setup({ model: 'qwen2.5-vl-7b-q4', replies: [() => reply('[]')] });
    await t.ask.run(findReq());
    expect(body(t.fetch)).not.toHaveProperty('chat_template_kwargs');
  });

  it('sends two labelled images for a change', async () => {
    const t = setup({ replies: [() => reply('[]')] });
    await t.ask.run(findReq({ kind: 'change', images: [img('a', 'May'), img('b', 'June')] }));
    const msgs = body(t.fetch).messages as { content: { type: string; text?: string }[] }[];
    const c = msgs[0]?.content ?? [];
    expect(c.map((p) => p.type)).toEqual(['text', 'image_url', 'text', 'image_url', 'text']);
    expect(c[0]?.text).toBe('Image 1 (May):');
    expect(c[2]?.text).toBe('Image 2 (June):');
  });

  it('reads qwen3 boxes as normalised and gives no cost', async () => {
    const t = setup({
      replies: [() => reply('[{"bbox_2d":[100,200,300,600],"label":"gauge","note":"left"}]')],
    });
    const r = await t.ask.run(findReq());
    expect(r).toMatchObject({
      ok: true,
      provider: 'local',
      model: 'qwen3.5-9b-q4_k_m',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0,
    });
    if (!r.ok) throw new Error('x');
    expect(r.items[0]?.box).toEqual([0.1, 0.2, 0.3, 0.6]);
  });

  it('asks once more after an unreadable reply', async () => {
    const t = setup({
      replies: [
        () => reply('I see some gauges.'),
        () => reply('[{"bbox_2d":[100,200,300,600],"label":"gauge"}]'),
      ],
    });
    const r = await t.ask.run(findReq());
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(r.ok && r.items).toHaveLength(1);
    expect(r.ok && r.inputTokens).toBe(200);
  });

  it('answers format after two unreadable replies', async () => {
    const t = setup({ replies: [() => reply('no'), () => reply('still no')] });
    const r = await t.ask.run(findReq());
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: false, code: 'format' });
    expect(t.release).toHaveBeenCalledTimes(1);
  });

  it('returns the text of an ask with think blocks stripped, after the turns', async () => {
    const t = setup({ replies: [() => reply('<think>hm</think>Two gauges.')] });
    const r = await t.ask.run(
      findReq({
        kind: 'ask',
        prompt: 'And the left one?',
        turns: [
          { role: 'user', text: 'What is here?' },
          { role: 'assistant', text: 'A tank.' },
        ],
      }),
    );
    expect(r.ok && r.text).toBe('Two gauges.');
    const msgs = body(t.fetch).messages as { role: string; content: unknown }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2]?.content).toBe('And the left one?');
  });

  it('keeps what was read when the answer is cut short', async () => {
    const t = setup({
      replies: [
        () => reply('[{"bbox_2d":[100,200,300,600],"label":"gauge"}]', { finish_reason: 'length' }),
      ],
    });
    const r = await t.ask.run(findReq());
    expect(r.ok && r.warnings).toContain('The answer was cut short.');
  });

  it('is busy while running and when the card is taken', async () => {
    let done: (r: Response) => void = () => undefined;
    const t = setup({ replies: [() => new Promise<Response>((res) => (done = res))] });
    const first = t.ask.run(findReq());
    await vi.waitFor(() => {
      expect(t.fetch).toHaveBeenCalled();
    });
    expect(t.ask.active()).toBe(true);
    const second = await t.ask.run(findReq({ runId: 'r2' }));
    expect(second).toMatchObject({
      ok: false,
      code: 'busy',
      error: 'The model on this PC is answering another request.',
    });
    done(reply('[]'));
    await first;
    expect(t.ask.active()).toBe(false);
    const g = setup({ gpuBusy: 'A detector run is at work.' });
    expect(await g.ask.run(findReq())).toMatchObject({
      ok: false,
      code: 'busy',
      error: 'A detector run is at work.',
    });
  });

  it('cancels a run', async () => {
    const t = setup({
      replies: [() => new Promise<Response>(() => undefined)],
    });
    t.fetch.mockImplementationOnce(
      (_u, i) =>
        new Promise<Response>((_res, rej) => {
          i.signal?.addEventListener('abort', () => {
            rej(new DOMException('x', 'AbortError'));
          });
        }),
    );
    const p = t.ask.run(findReq());
    await vi.waitFor(() => {
      expect(t.fetch).toHaveBeenCalled();
    });
    expect(t.ask.cancel('nope')).toBe(false);
    expect(t.ask.cancel('r1')).toBe(true);
    expect(await p).toEqual({ ok: false, error: 'Stopped.', stopped: true });
    expect(t.release).toHaveBeenCalledTimes(1);
    expect(t.idleIfUnused).toHaveBeenCalled();
  });

  it('answers no-pack with the newest unusable reason, and no-card with the card reason', async () => {
    const none = setup({ pack: null });
    expect(await none.ask.run(findReq())).toMatchObject({
      ok: false,
      code: 'no-pack',
      error: 'Too old for this app.',
    });
    const card = setup({ hw: { ok: false, reason: 'The card is busy.' } });
    expect(await card.ask.run(findReq())).toMatchObject({
      ok: false,
      code: 'no-card',
      error: 'The card is busy.',
    });
    expect(card.server.ensure).not.toHaveBeenCalled();
  });

  it('attaches the seam without a pack and reports ready', async () => {
    const t = setup({
      pack: null,
      env: { QUADRION_VLM_SERVER_URL: 'http://127.0.0.1:5555', QUADRION_VLM_MODEL: 'qwen3.5-x' },
      replies: [() => reply('[]')],
    });
    expect(await t.ask.status()).toEqual({ ready: true, model: 'qwen3.5-x' });
    const r = await t.ask.run(findReq());
    expect(r.ok).toBe(true);
    expect(t.findPack).not.toHaveBeenCalled();
    expect(t.server.attach).toHaveBeenCalledWith('http://127.0.0.1:5555', 'a'.repeat(64));
  });

  it('releases the lease after a failed request', async () => {
    const t = setup({ replies: [() => new Response('boom', { status: 500 })] });
    const r = await t.ask.run(findReq());
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(t.release).toHaveBeenCalledTimes(1);
    expect(t.idleIfUnused).toHaveBeenCalledTimes(1);
  });

  it('asks a Qwen2.5 pack for pixels and reads them as pixels', async () => {
    const t = setup({
      model: 'qwen2.5-vl-7b-q4',
      replies: [() => reply('[{"bbox_2d":[100,50,300,300],"label":"gauge"}]')],
    });
    const r = await t.ask.run(findReq());
    const msgs = body(t.fetch).messages as { content: { text?: string }[] }[];
    expect(msgs[0]?.content[2]?.text).not.toContain('0-1000');
    expect(r.ok && r.items[0]?.box).toEqual([0.1, 0.1, 0.3, 0.6]);
  });

  it('releases the lease once when the server cannot be reached', async () => {
    const t = setup({ replies: [() => Promise.reject(new Error('refused'))] });
    const r = await t.ask.run(findReq());
    expect(r.ok).toBe(false);
    expect(t.release).toHaveBeenCalledTimes(1);
    expect(t.idleIfUnused).toHaveBeenCalledTimes(1);
  });
});
