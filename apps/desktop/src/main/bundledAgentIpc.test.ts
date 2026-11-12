import { toolCheckVersion, type ToolCheckResult } from '@aio/ai/main';
import {
  BundledAgentCheck,
  type BundledAgentStatus,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
} from '@aio/schema';
import { en } from '@aio/ui/i18n/en';
import { describe, expect, it, vi } from 'vitest';
import type { BundledAcquire } from './analytics/agentModel';
import type { AnalyticsPack } from './analytics/pack';
import { CHECK_RUNNING, registerBundledAgentIpc } from './bundledAgentIpc';
import type { Handler } from './ipc';

const SHA = 'B'.repeat(64);
const pack = {
  version: '0.2.0',
  dir: 'D:/pack',
  manifest: {
    model: { id: 'qwen3.5-9b-q4_k_m', sha256: SHA },
    runtime: { name: 'llama.cpp', release: 'b11489', executable: 'llama-server.exe' },
  },
} as unknown as AnalyticsPack;

const result = (over: Partial<ToolCheckResult> = {}): ToolCheckResult => ({
  passed: true,
  total: 12,
  correct: 11,
  needed: 10,
  invalidCalls: 0,
  meanLatencyMs: 412.4,
  promptTokens: 10_957,
  cases: [
    { id: 'fly-to-place', ok: true, outcome: 'ok', tool: 'find_places', latencyMs: 400 },
    { id: 'survey-dates', ok: false, outcome: 'text-only', latencyMs: 300 },
  ],
  ...over,
});

const STATUS: BundledAgentStatus = { pack: null, check: null, blocked: null };

function setup(o: {
  pack?: AnalyticsPack | null;
  acquire?: BundledAcquire;
  run?: () => Promise<ToolCheckResult>;
}) {
  const handlers = new Map<string, Handler<IpcChannel>>();
  const release = vi.fn();
  const acquire = vi.fn(() =>
    Promise.resolve<BundledAcquire>(
      o.acquire ?? {
        ok: true,
        baseUrl: 'http://127.0.0.1:5555',
        apiKey: 'k'.repeat(32),
        modelId: 'qwen3.5-9b-q4_k_m',
        release,
      },
    ),
  );
  const status = vi.fn(() => Promise.resolve(STATUS));
  const saveCheck = vi.fn(() => Promise.resolve());
  const runCheck = vi.fn(o.run ?? (() => Promise.resolve(result())));
  registerBundledAgentIpc({
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    agent: { acquire, status },
    findPack: () => Promise.resolve(o.pack === undefined ? pack : o.pack),
    saveCheck,
    runCheck,
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  });
  const call = <C extends 'ai:bundledAgent' | 'ai:bundledAgentCheck'>(c: C) =>
    Promise.resolve((handlers.get(c) as unknown as Handler<C>)({} as IpcRequest<C>)) as Promise<
      IpcResponse<C>
    >;
  return { call, acquire, release, saveCheck, runCheck, status };
}

describe('bundled agent IPC', () => {
  it('ai:bundledAgent answers the status', async () => {
    const t = setup({});
    expect(await t.call('ai:bundledAgent')).toBe(STATUS);
  });

  it('checks the model through its server, stores the result for its SHA and releases', async () => {
    const t = setup({});
    const r = await t.call('ai:bundledAgentCheck');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.check).toEqual({
      modelSha256: SHA.toLowerCase(),
      runtimeRelease: 'b11489',
      checkVersion: toolCheckVersion(),
      modelId: 'qwen3.5-9b-q4_k_m',
      packVersion: '0.2.0',
      passed: true,
      correct: 11,
      total: 12,
      needed: 10,
      invalidCalls: 0,
      meanLatencyMs: 412,
      promptTokens: 10_957,
      checkedAt: '2026-11-12T10:00:00.000Z',
      cases: [
        { id: 'fly-to-place', ok: true, outcome: 'ok', tool: 'find_places' },
        { id: 'survey-dates', ok: false, outcome: 'text-only' },
      ],
    });
    // the stored shape is the contract's
    expect(BundledAgentCheck.safeParse(r.check).success).toBe(true);
    expect(t.saveCheck).toHaveBeenCalledWith(r.check);
    expect(r.status).toBe(STATUS);
    expect(t.release).toHaveBeenCalledTimes(1);
    expect(t.runCheck).toHaveBeenCalledTimes(1);
  });

  it('refuses without a pack, and while the card is busy, storing nothing', async () => {
    const none = setup({ pack: null });
    expect(await none.call('ai:bundledAgentCheck')).toEqual({
      ok: false,
      error: en['localAi.bundled.noPack'],
    });
    const busy = setup({ acquire: { ok: false, message: en['localAi.bundled.gpuBusy'] } });
    expect(await busy.call('ai:bundledAgentCheck')).toEqual({
      ok: false,
      error: en['localAi.bundled.gpuBusy'],
    });
    expect(busy.runCheck).not.toHaveBeenCalled();
    expect(busy.saveCheck).not.toHaveBeenCalled();
  });

  it('says when the model did not answer, and still releases it', async () => {
    const t = setup({ run: () => Promise.reject(new Error('connection refused')) });
    const r = await t.call('ai:bundledAgentCheck');
    expect(r).toEqual({
      ok: false,
      error: 'The bundled model did not answer the check: connection refused',
    });
    expect(t.release).toHaveBeenCalledTimes(1);
    expect(t.saveCheck).not.toHaveBeenCalled();
  });

  it('runs one check at a time', async () => {
    let finish: (r: ToolCheckResult) => void = () => undefined;
    const t = setup({ run: () => new Promise((ok) => (finish = ok)) });
    const first = t.call('ai:bundledAgentCheck');
    await vi.waitFor(() => {
      expect(t.runCheck).toHaveBeenCalled();
    });
    expect(await t.call('ai:bundledAgentCheck')).toEqual({ ok: false, error: CHECK_RUNNING });
    finish(result({ passed: false, correct: 2 }));
    const r = await first;
    expect(r.ok && r.check.passed).toBe(false);
  });
});
