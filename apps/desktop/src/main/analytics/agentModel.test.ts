import type { BundledAgentCheck } from '@aio/schema';
import { en } from '@aio/ui/i18n/en';
import { describe, expect, it, vi } from 'vitest';
import { createBundledAgent } from './agentModel';
import type { LocalAcquire } from './ask';
import type { AnalyticsPack } from './pack';
import { VLM_CONTEXT_TOKENS } from './server';

const SHA = 'b'.repeat(64);
const pack = {
  version: '0.2.0',
  dir: 'D:/pack',
  manifest: { model: { id: 'qwen3.5-9b-q4_k_m', sha256: SHA } },
  server: 's',
  gguf: 'g',
  mmproj: 'm',
} as unknown as AnalyticsPack;

const check = (over: Partial<BundledAgentCheck> = {}): BundledAgentCheck => ({
  modelSha256: SHA,
  modelId: 'qwen3.5-9b-q4_k_m',
  packVersion: '0.2.0',
  passed: true,
  correct: 12,
  total: 12,
  needed: 10,
  invalidCalls: 0,
  meanLatencyMs: 400,
  checkedAt: '2026-11-12T00:00:00.000Z',
  cases: [],
  ...over,
});

function setup(o: {
  pack?: AnalyticsPack | null;
  check?: BundledAgentCheck;
  acquire?: LocalAcquire;
}) {
  const release = vi.fn();
  const acquire = vi.fn(() =>
    Promise.resolve<LocalAcquire>(
      o.acquire ?? {
        ok: true,
        url: 'http://127.0.0.1:5555',
        key: 'k'.repeat(32),
        model: 'qwen3.5-9b-q4_k_m',
        release,
      },
    ),
  );
  const active = vi.fn(() => false);
  const agent = createBundledAgent({
    localAsk: { acquire, active },
    findPack: () => Promise.resolve(o.pack === undefined ? pack : o.pack),
    check: () => o.check,
  });
  return { agent, acquire, active, release };
}

describe('the bundled agent model', () => {
  it('status names the pack, its model and the 16k context; ready after a pass', async () => {
    const t = setup({ check: check() });
    const s = await t.agent.status();
    expect(s.pack).toEqual({
      version: '0.2.0',
      modelId: 'qwen3.5-9b-q4_k_m',
      modelSha256: SHA,
      contextTokens: VLM_CONTEXT_TOKENS,
    });
    expect(s.blocked).toBeNull();
    expect(await t.agent.ready()).toBeNull();
  });

  it('blocks without a pack', async () => {
    const t = setup({ pack: null, check: check() });
    expect((await t.agent.status()).blocked).toBe(en['localAi.bundled.noPack']);
  });

  it('blocks until checked, and again for a new model file', async () => {
    expect(await setup({}).agent.ready()).toBe(en['localAi.bundled.checkFirst']);
    const other = setup({ check: check({ modelSha256: 'c'.repeat(64) }) });
    expect(await other.agent.ready()).toBe(en['localAi.bundled.checkFirst']);
    // the stored check is still shown, whatever model it ran on
    expect((await other.agent.status()).check?.modelSha256).toBe('c'.repeat(64));
  });

  it('blocks after a failed check with the score and what to use instead', async () => {
    const t = setup({ check: check({ passed: false, correct: 3, total: 12, needed: 10 }) });
    expect(await t.agent.ready()).toBe(
      'The bundled model made the right tool call in 3 of 12 checks (10 needed), so it cannot run Offline AI on this computer. Use your own local model server with tool calling, or cloud AI.',
    );
  });

  it('acquire hands over the address, key and model, and the release', async () => {
    const t = setup({ check: check() });
    const got = await t.agent.acquire();
    expect(got).toMatchObject({
      ok: true,
      baseUrl: 'http://127.0.0.1:5555',
      apiKey: 'k'.repeat(32),
      modelId: 'qwen3.5-9b-q4_k_m',
    });
    if (got.ok) got.release();
    expect(t.release).toHaveBeenCalledTimes(1);
  });

  it('acquire says the card is busy with a detector run in the agent’s words', async () => {
    const t = setup({ acquire: { ok: false, code: 'gpu', error: 'A detector run is using it.' } });
    expect(await t.agent.acquire()).toEqual({
      ok: false,
      message: en['localAi.bundled.gpuBusy'],
    });
    const busy = setup({ acquire: { ok: false, code: 'busy', error: 'x' } });
    expect(await busy.agent.acquire()).toEqual({ ok: false, message: en['localAi.bundled.busy'] });
    const card = setup({ acquire: { ok: false, code: 'no-card', error: 'Not enough memory.' } });
    expect(await card.agent.acquire()).toEqual({ ok: false, message: 'Not enough memory.' });
  });

  it('is active while the local ask holds the model', () => {
    const t = setup({});
    t.active.mockReturnValue(true);
    expect(t.agent.active()).toBe(true);
  });
});
