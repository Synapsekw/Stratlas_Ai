import { ipc, type IpcRequest } from '@aio/schema';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTENNA_LABEL_PROMPT_VERSION } from './antennaLabel';
import {
  createAgentRuntime,
  MESSAGES,
  type AgentRuntimeHost,
  type StepUsage,
  type TelecomLabelHost,
} from './main';
import { createProviderRegistry, type ModelProvider } from './providers';
import type { ModelRoute } from './routes';

/** An 8 x 8 PNG (header only: the mock model never decodes it). */
const PNG = `data:image/png;base64,${Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from('IHDR', 'latin1'),
  Buffer.from([0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0, 0, 0, 0, 0]),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('IEND', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
]).toString('base64')}`;

const NOT_OPEN = 'The project is not open. Open it, then try again.';
const PREVIEW_FIRST = 'Show the send preview first.';
const NO_PHOTOS = 'Photos of this project may not leave this computer. Allow them in the preview.';

interface Opts {
  provider?: 'anthropic' | 'openai' | 'local';
  /** Units that have a crop on disk. */
  have?: string[];
  photos?: boolean;
  ai?: 'allow' | 'forbid';
  offline?: boolean;
  open?: boolean;
  /** What the model answers; default: every key in the prompt is a panel. */
  answer?: (keys: string[]) => string;
  /** The nth model request (1 based) fails. */
  failOn?: number;
}

const KEYS_IN = /ant-[a-z0-9-]+/g;

function setup(o: Opts = {}) {
  const providerId = o.provider ?? 'anthropic';
  const have = new Set(o.have ?? ['ant-1', 'ant-2', 'ant-3', 'ant-4', 'ant-5', 'ant-6']);
  /** The crop version on disk; a test bumps it to change the files after a preview. */
  const disk = { version: 'v1' };
  const answer =
    o.answer ??
    ((keys) =>
      JSON.stringify({
        labels: keys.map((key) => ({ key, label: 'panel', reason: 'tall and flat' })),
      }));
  let requests = 0;
  const model = new MockLanguageModelV4({
    modelId: 'claude-opus-5-5',
    doGenerate: (options) => {
      requests += 1;
      if (o.failOn === requests) return Promise.reject(new Error('boom'));
      const user = options.prompt.find((m) => m.role === 'user');
      const first = user?.role === 'user' ? user.content.find((p) => p.type === 'text') : undefined;
      const keys = first?.type === 'text' ? (first.text.match(KEYS_IN) ?? []) : [];
      return Promise.resolve({
        content: [{ type: 'text' as const, text: answer(keys) }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 100, text: 100, reasoning: 0 },
        },
        warnings: [],
      });
    },
  });
  const provider: ModelProvider = {
    id: providerId,
    label: providerId,
    cloud: providerId !== 'local',
    needsKey: false,
    languageModel: () => model,
  };
  const route: ModelRoute = { task: 'vision', provider: providerId, model: 'claude-opus-5-5' };
  const policyReads: string[] = [];
  const cropReads: string[][] = [];
  const recorded: StepUsage[] = [];
  const telecom: TelecomLabelHost = {
    policy: (projectId) => {
      policyReads.push(projectId);
      if (o.open === false) return Promise.resolve(null);
      return Promise.resolve({ ai: o.ai ?? 'allow', photos: o.photos ?? false });
    },
    crops: (_projectId, ids) => {
      cropReads.push([...ids]);
      return Promise.resolve(
        ids
          .filter((id) => have.has(id))
          .map((unitId) => ({
            unitId,
            path: `telecom/crops/${unitId}.jpg`,
            dataUrl: PNG,
            sha256: `sha-${unitId}-${disk.version}`,
          })),
      );
    },
  };
  const host: AgentRuntimeHost = {
    getKey: () => Promise.resolve('test-key-not-real'),
    cloudAllowed: () => true,
    offlineOnly: () => o.offline === true,
    emit: () => undefined,
    routes: () => [route],
    recordUsage: (_projectId, usage) => recorded.push(usage),
    telecom,
  };
  const runtime = createAgentRuntime(host, {
    providers: createProviderRegistry([provider]),
    maxRetries: 0,
  });
  return { runtime, model, policyReads, cropReads, recorded, disk };
}

const ids = (...n: number[]) => n.map((i) => `ant-${String(i)}`);

function labelReq(
  over: Partial<IpcRequest<'ai:labelAntennas'>> = {},
): IpcRequest<'ai:labelAntennas'> {
  return { runId: 'r1', projectId: 'p1', unitIds: ids(1, 2), ...over };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ai:antennaLabelPreview', () => {
  it('returns the crops, the route, the estimate and a token', async () => {
    const t = setup({ photos: true });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    expect(p).toMatchObject({
      ok: true,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      cloud: true,
      photosAllowed: true,
      crops: [
        { unitId: 'ant-1', path: 'telecom/crops/ant-1.jpg' },
        { unitId: 'ant-2', path: 'telecom/crops/ant-2.jpg' },
      ],
      missing: [],
      estimate: { images: 2 },
    });
    expect(ipc['ai:antennaLabelPreview'].response.parse(p)).toEqual(p);
    if (p.ok) {
      expect(p.token.length).toBeGreaterThan(8);
      expect(p.estimate.inputTokens).toBeGreaterThan(0);
    }
  });

  it('lists units without a crop as missing and counts only the crops', async () => {
    const t = setup({ have: ['ant-1', 'ant-3'] });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2, 3) });
    expect(p).toMatchObject({ ok: true, missing: ['ant-2'], estimate: { images: 2 } });
    expect(p.ok && p.crops.map((c) => c.unitId)).toEqual(['ant-1', 'ant-3']);
  });

  it('refuses when no unit has a crop, with no token', async () => {
    const t = setup({ have: [] });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1) });
    expect(p.ok).toBe(false);
    expect(p).not.toHaveProperty('token');
  });

  it('refuses offline-only before anything is read', async () => {
    const t = setup({ offline: true });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1) });
    expect(p).toEqual({ ok: false, error: MESSAGES.offlineOnly });
    expect(t.cropReads).toEqual([]);
    expect(t.policyReads).toEqual([]);
  });

  it('refuses a project that is not open', async () => {
    const t = setup({ open: false });
    expect(await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1) })).toEqual({
      ok: false,
      error: NOT_OPEN,
    });
    expect(t.cropReads).toEqual([]);
  });
});

describe('ai:labelAntennas gates', () => {
  it('refuses offline-only before anything is read or sent', async () => {
    const t = setup({ offline: true, photos: true });
    const r = await t.runtime.labelAntennas(labelReq({ token: 'whatever', photos: true }));
    expect(r).toEqual({ ok: false, error: MESSAGES.offlineOnly });
    expect(t.cropReads).toEqual([]);
    expect(t.policyReads).toEqual([]);
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('refuses a cloud call without a valid preview token, reading nothing', async () => {
    const t = setup({ photos: true });
    expect(await t.runtime.labelAntennas(labelReq())).toEqual({ ok: false, error: PREVIEW_FIRST });
    expect(await t.runtime.labelAntennas(labelReq({ token: 'not-a-token' }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
    expect(t.cropReads).toEqual([]);
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('accepts a token once: a reused token is refused', async () => {
    const t = setup({ photos: true });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!p.ok) throw new Error(p.error);
    const first = await t.runtime.labelAntennas(labelReq({ token: p.token }));
    expect(first.ok).toBe(true);
    const again = await t.runtime.labelAntennas(labelReq({ runId: 'r2', token: p.token }));
    expect(again).toEqual({ ok: false, error: PREVIEW_FIRST });
    expect(t.model.doGenerateCalls).toHaveLength(1);
  });

  it('refuses a token issued for other unit ids, and the refused token is spent', async () => {
    const t = setup({ photos: true });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!p.ok) throw new Error(p.error);
    const other = await t.runtime.labelAntennas(labelReq({ unitIds: ids(1, 3), token: p.token }));
    expect(other).toEqual({ ok: false, error: PREVIEW_FIRST });
    expect(await t.runtime.labelAntennas(labelReq({ token: p.token }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('refuses a token issued for another project', async () => {
    const t = setup({ photos: true });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!p.ok) throw new Error(p.error);
    expect(await t.runtime.labelAntennas(labelReq({ projectId: 'p2', token: p.token }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('accepts the same units in another order but not crops changed since the preview', async () => {
    const t = setup({ photos: true });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!p.ok) throw new Error(p.error);
    const ok = await t.runtime.labelAntennas(labelReq({ unitIds: ids(2, 1), token: p.token }));
    expect(ok.ok).toBe(true);

    const q = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!q.ok) throw new Error(q.error);
    t.disk.version = 'v2';
    expect(await t.runtime.labelAntennas(labelReq({ runId: 'r2', token: q.token }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
    expect(t.model.doGenerateCalls).toHaveLength(1);
  });

  it('refuses an expired token', async () => {
    const t = setup({ photos: true });
    const now = Date.now();
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!p.ok) throw new Error(p.error);
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
    expect(await t.runtime.labelAntennas(labelReq({ token: p.token }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('refuses photos without consent and accepts the per-request consent', async () => {
    const t = setup({ photos: false });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!p.ok) throw new Error(p.error);
    expect(p.photosAllowed).toBe(false);
    expect(await t.runtime.labelAntennas(labelReq({ token: p.token }))).toEqual({
      ok: false,
      error: NO_PHOTOS,
    });
    expect(t.model.doGenerateCalls).toHaveLength(0);
    // an explicit false is no consent either
    const q = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!q.ok) throw new Error(q.error);
    expect(await t.runtime.labelAntennas(labelReq({ token: q.token, photos: false }))).toEqual({
      ok: false,
      error: NO_PHOTOS,
    });
    const r = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!r.ok) throw new Error(r.error);
    const done = await t.runtime.labelAntennas(labelReq({ token: r.token, photos: true }));
    expect(done.ok).toBe(true);
    expect(t.model.doGenerateCalls).toHaveLength(1);
  });

  it('accepts the project photo flag without a per-request consent', async () => {
    const t = setup({ photos: true });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!p.ok) throw new Error(p.error);
    expect((await t.runtime.labelAntennas(labelReq({ token: p.token }))).ok).toBe(true);
  });

  it('refuses a project whose manifest forbids cloud AI, even with consent', async () => {
    const t = setup({ photos: true, ai: 'forbid' });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    expect(p).toEqual({ ok: false, error: MESSAGES.forbidden });
    const r = await t.runtime.labelAntennas(labelReq({ token: 'x', photos: true }));
    expect(r.ok).toBe(false);
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('refuses a second request with the same run id while one is out', async () => {
    const t = setup({ photos: true });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!p.ok) throw new Error(p.error);
    const q = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2) });
    if (!q.ok) throw new Error(q.error);
    const a = t.runtime.labelAntennas(labelReq({ token: p.token }));
    const b = await t.runtime.labelAntennas(labelReq({ token: q.token }));
    expect(b).toEqual({ ok: false, error: MESSAGES.busy });
    expect((await a).ok).toBe(true);
  });
});

describe('ai:labelAntennas', () => {
  it('labels in batches of four and records the usage once, summed', async () => {
    const t = setup({ photos: true });
    const all = ids(1, 2, 3, 4, 5, 6);
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: all });
    if (!p.ok) throw new Error(p.error);
    const r = await t.runtime.labelAntennas(labelReq({ unitIds: all, token: p.token }));
    expect(r).toMatchObject({
      ok: true,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      promptVersion: ANTENNA_LABEL_PROMPT_VERSION,
      inputTokens: 2000,
      outputTokens: 200,
      warnings: [],
    });
    if (!r.ok) return;
    expect(ipc['ai:labelAntennas'].response.parse(r)).toEqual(r);
    expect(r.labels.map((l) => l.unitId)).toEqual(all);
    expect(r.labels.every((l) => l.label === 'panel' && l.reason === 'tall and flat')).toBe(true);
    expect(t.model.doGenerateCalls).toHaveLength(2);
    const filesPer = t.model.doGenerateCalls.map((c) =>
      c.prompt
        .flatMap((m) => (m.role === 'user' ? m.content : []))
        .filter((x) => x.type === 'file'),
    );
    expect(filesPer.map((f) => f.length)).toEqual([4, 2]);
    expect(t.recorded).toHaveLength(1);
    expect(t.recorded[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      inputTokens: 2000,
      outputTokens: 200,
    });
  });

  it('sends the fixed instructions, which never ask for a number', async () => {
    const t = setup({ photos: true });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1) });
    if (!p.ok) throw new Error(p.error);
    await t.runtime.labelAntennas(labelReq({ unitIds: ids(1), token: p.token }));
    const call = t.model.doGenerateCalls[0];
    const system = call?.prompt.find((m) => m.role === 'system');
    const text = system?.role === 'system' ? system.content : '';
    expect(text).toContain('short-antenna');
    expect(text).not.toMatch(/azimuth|tilt|degree|size/i);
  });

  it('skips units with no crop and warns about unlabelled or invalid answers', async () => {
    const t = setup({
      photos: true,
      have: ['ant-1', 'ant-2'],
      answer: () => JSON.stringify({ labels: [{ key: 'ant-1', label: 'omni', reason: 'round' }] }),
    });
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1, 2, 3) });
    if (!p.ok) throw new Error(p.error);
    const r = await t.runtime.labelAntennas(labelReq({ unitIds: ids(1, 2, 3), token: p.token }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.labels).toEqual([]);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('returns an error and still records what was spent when a later batch fails', async () => {
    const t = setup({ photos: true, failOn: 2 });
    const all = ids(1, 2, 3, 4, 5, 6);
    const p = await t.runtime.antennaLabelPreview({ projectId: 'p1', unitIds: all });
    if (!p.ok) throw new Error(p.error);
    const r = await t.runtime.labelAntennas(labelReq({ unitIds: all, token: p.token }));
    expect(r.ok).toBe(false);
    expect(t.recorded).toHaveLength(1);
    expect(t.recorded[0]).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
  });

  it('a local route needs no token and no photo consent', async () => {
    const t = setup({ provider: 'local', photos: false });
    const r = await t.runtime.labelAntennas(labelReq());
    expect(r).toMatchObject({ ok: true, provider: 'local' });
    expect(t.model.doGenerateCalls).toHaveLength(1);
    expect(t.recorded[0]).toMatchObject({ provider: 'local', costUsd: 0 });
  });

  it('is refused when the host has no telecom support', async () => {
    const model = new MockLanguageModelV4({ modelId: 'claude-opus-5-5' });
    const provider: ModelProvider = {
      id: 'anthropic',
      label: 'Anthropic',
      cloud: true,
      needsKey: false,
      languageModel: () => model,
    };
    const rt = createAgentRuntime(
      { getKey: () => Promise.resolve(null), cloudAllowed: () => true, emit: () => undefined },
      { providers: createProviderRegistry([provider]) },
    );
    expect((await rt.labelAntennas(labelReq())).ok).toBe(false);
    expect((await rt.antennaLabelPreview({ projectId: 'p1', unitIds: ids(1) })).ok).toBe(false);
  });
});
