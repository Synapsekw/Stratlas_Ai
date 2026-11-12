/**
 * The bundled model as the offline agent (A3): the gate (`ai:status` and `ai:send` refuse until
 * the tool-calling check passed), and a run that takes the model per run, talks to the address
 * and key it was handed with the compact profile, and releases it at the end. The model is a
 * small OpenAI-compatible server on 127.0.0.1 in this test.
 */
import type { IpcEvent, IpcRequest, LocalModelSettings } from '@aio/schema';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_CONTEXT_TOKENS,
  createAgentRuntime,
  effectiveLocal,
  MESSAGES,
  type AgentRuntimeHost,
  type BundledLease,
} from './main';
import { toolsForWindow } from './tools';

type AiEvent = IpcEvent<'ai:event'>;

interface Seen {
  path: string;
  authorization: string | undefined;
  model: string;
  tools: string[];
  maxTokens: number | undefined;
}

let server: Server;
let origin: string;
let seen: Seen[];
/** `tool`: the streamed answer is a call of list_layers, else text. */
let replyWith: 'text' | 'tool';

beforeEach(async () => {
  seen = [];
  replyWith = 'text';
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        model: string;
        tools?: { function: { name: string } }[];
        max_tokens?: number;
        max_completion_tokens?: number;
        stream?: boolean;
      };
      seen.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        model: body.model,
        tools: (body.tools ?? []).map((t) => t.function.name),
        maxTokens: body.max_completion_tokens ?? body.max_tokens,
      });
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Bundled.' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model };
      const send = (v: unknown) => res.write(`data: ${JSON.stringify(v)}\n\n`);
      if (replyWith === 'tool') {
        const call = { index: 0, id: 'call_1', type: 'function' };
        const fn = { name: 'list_layers', arguments: '{}' };
        send({
          ...base,
          choices: [
            { index: 0, delta: { role: 'assistant', tool_calls: [{ ...call, function: fn }] } },
          ],
        });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        res.end('data: [DONE]\n\n');
        return;
      }
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Bundled.' } }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((ok) => {
    server.close(() => {
      ok();
    });
  });
});

const KEY = 'k'.repeat(32);
const BUNDLED: LocalModelSettings = {
  enabled: true,
  source: 'bundled',
  // the person's own server stays in the settings for switching back
  baseUrl: 'http://192.168.1.20:11434/v1',
  model: 'qwen3.5-9b-q4_k_m',
};
const routes = () =>
  (['chat', 'vision', 'report', 'extract', 'build', 'engineer'] as const).map((task) => ({
    task,
    provider: 'local' as const,
    model: 'qwen3.5-9b-q4_k_m',
  }));

const req = (over: Partial<IpcRequest<'ai:send'>> = {}): IpcRequest<'ai:send'> => ({
  runId: 'r1',
  window: 'scene3d',
  context: {},
  messages: [{ role: 'user', content: 'Hello' }],
  ...over,
});

function setup(o: {
  ready?: string | null;
  lease?: () => BundledLease;
  bundled?: false;
  cfg?: LocalModelSettings;
}) {
  const release = vi.fn();
  const acquire = vi.fn((): Promise<BundledLease> =>
    Promise.resolve(
      o.lease?.() ?? {
        ok: true,
        baseUrl: origin,
        apiKey: KEY,
        modelId: 'served-model',
        release,
      },
    ),
  );
  const events: AiEvent[] = [];
  let ended: (e: AiEvent) => void = () => undefined;
  const end = new Promise<AiEvent>((ok) => (ended = ok));
  const host: AgentRuntimeHost = {
    getKey: () => Promise.resolve(null),
    cloudAllowed: () => false,
    emit: (e) => {
      events.push(e);
      if (e.type === 'done' || e.type === 'error') ended(e);
    },
    routes,
    localModel: () => o.cfg ?? BUNDLED,
    ...(o.bundled === false ? {} : { bundled: { ready: () => o.ready ?? null, acquire } }),
  };
  const runtime = createAgentRuntime(host, { maxRetries: 0 });
  return { runtime, events, end, acquire, release };
}

describe('the bundled model as the offline agent', () => {
  it('is not ready until its check passed, with the reason from main', async () => {
    const t = setup({ ready: 'Check the tool calling first.' });
    expect(await t.runtime.status({})).toMatchObject({
      ready: false,
      reason: 'no-route',
      message: 'Check the tool calling first.',
      cloud: false,
    });
    expect(await t.runtime.send(req())).toEqual({
      ok: false,
      error: 'Check the tool calling first.',
    });
    expect(t.acquire).not.toHaveBeenCalled();
  });

  it('is not ready without the host side', async () => {
    const t = setup({ bundled: false });
    expect(await t.runtime.status({})).toMatchObject({
      ready: false,
      message: MESSAGES.bundledMissing,
    });
  });

  it('refuses callers that do not take the model per run (detect, engineer, test)', async () => {
    const t = setup({});
    expect(await t.runtime.status({ task: 'engineer' })).toMatchObject({
      ready: false,
      message: MESSAGES.bundledAgentOnly,
    });
    expect(await t.runtime.testConnection({ provider: 'local' })).toMatchObject({
      ok: false,
      message: MESSAGES.bundledAgentOnly,
    });
  });

  it('runs on the address, key and model it was handed, compact, then releases', async () => {
    const t = setup({});
    expect(await t.runtime.status({})).toMatchObject({
      ready: true,
      cloud: false,
      route: { provider: 'local' },
    });
    expect(await t.runtime.send(req())).toEqual({ ok: true });
    const e = await t.end;
    expect(e.type).toBe('done');
    expect(t.events.flatMap((x) => (x.type === 'text' ? [x.delta] : []))).toContain('Bundled.');
    expect(t.acquire).toHaveBeenCalledTimes(1);
    expect(t.release).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/v1/chat/completions');
    expect(seen[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.model).toBe('served-model');
    // the compact tool list, and a quarter of the 16k context for the answer
    const compact = toolsForWindow('scene3d', 'compact', { task: 'chat' }).map((s) => s.meta.name);
    expect(seen[0]?.tools.length).toBeGreaterThan(0);
    expect(seen[0]?.tools.length).toBeLessThanOrEqual(compact.length);
    expect(seen[0]?.tools.length).toBeLessThan(
      toolsForWindow('scene3d', 'full', { task: 'chat' }).length,
    );
    expect(seen[0]?.maxTokens).toBe(BUNDLED_CONTEXT_TOKENS / 4);
  });

  it('says why when the model cannot be taken (a detector run holds the card)', async () => {
    const t = setup({ lease: () => ({ ok: false, message: 'The card is busy.' }) });
    expect(await t.runtime.send(req())).toEqual({ ok: true });
    const e = await t.end;
    expect(e).toMatchObject({ type: 'error', message: 'The card is busy.' });
    expect(seen).toHaveLength(0);
  });

  it('releases the model when the server is gone, with a message of its own', async () => {
    const t = setup({});
    server.closeAllConnections();
    await new Promise<void>((ok) => {
      server.close(() => {
        ok();
      });
    });
    expect(await t.runtime.send(req())).toEqual({ ok: true });
    const e = await t.end;
    expect(e).toMatchObject({ type: 'error', message: MESSAGES.bundledDown });
    expect(t.release).toHaveBeenCalledTimes(1);
    // afterEach closes it again
    server = createServer();
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  });

  it('a draft takes and releases the model too', async () => {
    const t = setup({});
    const r = await t.runtime.draft({
      runId: 'd1',
      projectId: 'p1',
      task: 'report',
      system: 'Write.',
      prompt: 'A line.',
    });
    expect(r).toMatchObject({ ok: true, text: 'Bundled.' });
    expect(t.release).toHaveBeenCalledTimes(1);
  });

  it('a run waiting on an approval stops when the window goes, and gives the model back', async () => {
    replyWith = 'tool';
    const t = setup({});
    expect(await t.runtime.send(req())).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(t.events.some((e) => e.type === 'tool-call')).toBe(true);
    });
    expect(t.release).not.toHaveBeenCalled();
    t.runtime.cancelAll();
    expect(await t.end).toMatchObject({ type: 'error', message: MESSAGES.stopped });
    expect(t.release).toHaveBeenCalledTimes(1);
  });

  it('the engineer step never reaches a stand-in address on a bundled route', async () => {
    const t = setup({});
    const host = { policy: () => Promise.resolve(null) };
    const runtime = createAgentRuntime(
      {
        getKey: () => Promise.resolve(null),
        cloudAllowed: () => false,
        emit: () => undefined,
        routes,
        localModel: () => BUNDLED,
        bundled: { ready: () => null, acquire: t.acquire },
        engineer: host,
      },
      { maxRetries: 0 },
    );
    const preview = await runtime.engineerPreview(
      {} as unknown as IpcRequest<'ai:engineerPreview'>,
    );
    expect(preview).toEqual({ ok: false, error: MESSAGES.bundledAgentOnly });
    const run = await runtime.engineer({
      runId: 'e1',
      projectId: 'p1',
      engineerRun: 'r1',
    } as unknown as IpcRequest<'ai:engineer'>);
    expect(run).toMatchObject({ kind: 'refused', reason: MESSAGES.bundledAgentOnly });
    expect(t.acquire).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it('effectiveLocal: compact, 16k context and vision unless the settings say otherwise', () => {
    expect(effectiveLocal(BUNDLED)).toMatchObject({
      toolProfile: 'compact',
      contextTokens: BUNDLED_CONTEXT_TOKENS,
      capabilities: { tools: true, vision: true },
    });
    expect(
      effectiveLocal({
        ...BUNDLED,
        toolProfile: 'full',
        capabilities: { tools: false, vision: false },
      }),
    ).toMatchObject({ toolProfile: 'compact', capabilities: { tools: false, vision: false } });
    const own: LocalModelSettings = { enabled: true, baseUrl: origin, model: 'm' };
    expect(effectiveLocal(own)).toBe(own);
  });
});
