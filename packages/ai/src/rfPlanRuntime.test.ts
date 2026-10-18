import { ipc, type IpcRequest } from '@aio/schema';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentRuntime,
  MESSAGES,
  type AgentRuntimeHost,
  type StepUsage,
  type TelecomLabelHost,
} from './main';
import { createProviderRegistry, type ModelProvider } from './providers';
import type { ModelRoute } from './routes';
import { RF_PLAN_PROMPT_VERSION, rfPlanInstructions } from './rfPlan';

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

interface Opts {
  provider?: 'anthropic' | 'local';
  /** Units that have a crop on disk. */
  have?: string[];
  photos?: boolean;
  ai?: 'allow' | 'forbid';
  offline?: boolean;
  open?: boolean;
  /** The chat route goes to another model than the vision route. */
  chatModel?: string;
  answer?: string;
  fail?: boolean;
  /** The vision route goes to a local model that cannot see images (the chat route stays). */
  blindLocalVision?: boolean;
}

const UNIT_IN = /ant-[0-9]+/g;

function setup(o: Opts = {}) {
  const providerId = o.provider ?? 'anthropic';
  const have = new Set(o.have ?? ['ant-1', 'ant-2']);
  const disk = { version: 'v1' };
  const model = new MockLanguageModelV4({
    modelId: 'claude-opus-5-5',
    doGenerate: (options) => {
      if (o.fail) return Promise.reject(new Error('boom'));
      const user = options.prompt.find((m) => m.role === 'user');
      const first = user?.role === 'user' ? user.content.find((p) => p.type === 'text') : undefined;
      const units = first?.type === 'text' ? [...new Set(first.text.match(UNIT_IN) ?? [])] : [];
      const text =
        o.answer ??
        JSON.stringify({
          picks: units.map((unitId) => ({
            unitId,
            entryId: 'generic-aau-64t64r-n78',
            band: 'n78',
            tech: 'nr',
            bandwidthMhz: 100,
            reason: 'wide and deep',
            confidence: 'high',
          })),
        });
      return Promise.resolve({
        content: [{ type: 'text' as const, text }],
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
  const local: ModelProvider = {
    id: 'local',
    label: 'local',
    cloud: false,
    needsKey: false,
    languageModel: () => model,
  };
  const routes: ModelRoute[] = [
    o.blindLocalVision
      ? { task: 'vision', provider: 'local', model: 'local-text-only' }
      : { task: 'vision', provider: providerId, model: 'claude-opus-5-5' },
    { task: 'chat', provider: providerId, model: o.chatModel ?? 'claude-opus-5-5' },
  ];
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
    routes: () => routes,
    ...(o.blindLocalVision
      ? {
          localModel: () => ({
            enabled: true,
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'local-text-only',
            capabilities: { tools: true, vision: false },
          }),
        }
      : {}),
    recordUsage: (_projectId, usage) => recorded.push(usage),
    telecom,
  };
  const runtime = createAgentRuntime(host, {
    providers: createProviderRegistry(
      o.blindLocalVision && providerId !== 'local' ? [provider, local] : [provider],
    ),
    maxRetries: 0,
  });
  return { runtime, model, policyReads, cropReads, recorded, disk };
}

const CATALOGUE: IpcRequest<'ai:rfPlan'>['catalogue'] = [
  { id: 'generic-aau-64t64r-n78', kind: 'aau', vendor: 'Generic', model: 'AAU', bands: ['n78'] },
  { id: 'generic-panel-65-17', kind: 'antenna', vendor: 'Generic', model: 'Panel', bands: ['B3'] },
];

function planReq(over: Partial<IpcRequest<'ai:rfPlan'>> = {}): IpcRequest<'ai:rfPlan'> {
  return {
    runId: 'r1',
    projectId: 'p1',
    units: [
      { unitId: 'ant-1', widthM: 0.5, depthM: 0.2 },
      { unitId: 'ant-2', widthM: 0.3 },
    ],
    catalogue: CATALOGUE,
    ...over,
  };
}

const preview = (t: ReturnType<typeof setup>, unitIds = ['ant-1', 'ant-2']) =>
  t.runtime.rfPlanPreview({ projectId: 'p1', unitIds });

/** The parts of the one request the model saw. */
function sent(t: ReturnType<typeof setup>) {
  const call = t.model.doGenerateCalls[0];
  const user = call?.prompt.find((m) => m.role === 'user');
  const parts = user?.role === 'user' ? user.content : [];
  const system = call?.prompt.find((m) => m.role === 'system');
  return {
    files: parts.filter((p) => p.type === 'file').length,
    text: parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n'),
    system: system?.role === 'system' ? system.content : '',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ai:rfPlanPreview', () => {
  it('with photo consent: the vision route, the crops, the estimate and a token', async () => {
    const t = setup({ photos: true });
    const p = await preview(t);
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
    });
    expect(ipc['ai:rfPlanPreview'].response.parse(p)).toEqual(p);
    if (!p.ok) throw new Error(p.error);
    expect(p.token.length).toBeGreaterThan(8);
    expect(p.estimate.inputTokens).toBeGreaterThan(0);
    expect(p.estimate.costUsd).toBeGreaterThan(0);
  });

  it('without photo consent: the chat route and no crops, smaller estimate', async () => {
    const withPhotos = await preview(setup({ photos: true }));
    const t = setup({ photos: false, chatModel: 'claude-sonnet-5' });
    const p = await preview(t);
    expect(p).toMatchObject({
      ok: true,
      model: 'claude-sonnet-5',
      photosAllowed: false,
      crops: [],
    });
    if (!p.ok || !withPhotos.ok) throw new Error('preview failed');
    expect(p.estimate.inputTokens).toBeLessThan(withPhotos.estimate.inputTokens);
  });

  it('with no crops on disk: the chat route, still a token', async () => {
    const t = setup({ photos: true, have: [], chatModel: 'claude-sonnet-5' });
    const p = await preview(t);
    expect(p).toMatchObject({ ok: true, model: 'claude-sonnet-5', crops: [] });
  });

  it('refuses offline-only before any crop is read, even with photo consent', async () => {
    const t = setup({ offline: true, photos: true });
    expect(await preview(t)).toEqual({ ok: false, error: MESSAGES.offlineOnly });
    expect(t.cropReads).toEqual([]);
  });

  it('refuses a project that is not open', async () => {
    const t = setup({ open: false });
    expect(await preview(t)).toEqual({ ok: false, error: NOT_OPEN });
    expect(t.cropReads).toEqual([]);
  });

  it('refuses a project whose policy forbids cloud AI, with no token', async () => {
    const t = setup({ ai: 'forbid', photos: true });
    const p = await preview(t);
    expect(p).toEqual({ ok: false, error: MESSAGES.forbidden });
    expect(t.cropReads).toEqual([]);
  });

  it('falls back to the chat route with no crops when the vision route cannot answer', async () => {
    const t = setup({ photos: true, blindLocalVision: true, chatModel: 'claude-sonnet-5' });
    const p = await preview(t);
    expect(p).toMatchObject({
      ok: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      cloud: true,
      photosAllowed: true,
      crops: [],
    });
    expect(t.cropReads).toEqual([]);
    if (!p.ok) throw new Error(p.error);
    const r = await t.runtime.rfPlan(planReq({ token: p.token }));
    expect(r).toMatchObject({ ok: true, provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(sent(t).files).toBe(0);
  });

  it('a local provider costs 0', async () => {
    const t = setup({ provider: 'local' });
    const p = await preview(t);
    expect(p).toMatchObject({ ok: true, cloud: false, estimate: { costUsd: 0 } });
  });
});

describe('ai:rfPlan gates', () => {
  it('a cloud request without a fresh preview token answers the "preview first" error', async () => {
    const t = setup({ photos: true });
    expect(await t.runtime.rfPlan(planReq())).toEqual({ ok: false, error: PREVIEW_FIRST });
    expect(await t.runtime.rfPlan(planReq({ token: 'not-a-token' }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('accepts a token once: a reused token is refused', async () => {
    const t = setup({ photos: true });
    const p = await preview(t);
    if (!p.ok) throw new Error(p.error);
    expect((await t.runtime.rfPlan(planReq({ token: p.token }))).ok).toBe(true);
    expect(await t.runtime.rfPlan(planReq({ runId: 'r2', token: p.token }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
    expect(t.model.doGenerateCalls).toHaveLength(1);
  });

  it('refuses a token for other units or another project, and spends it', async () => {
    const t = setup({ photos: true });
    const p = await preview(t);
    if (!p.ok) throw new Error(p.error);
    const other = await t.runtime.rfPlan(planReq({ units: [{ unitId: 'ant-1' }], token: p.token }));
    expect(other).toEqual({ ok: false, error: PREVIEW_FIRST });
    expect(await t.runtime.rfPlan(planReq({ token: p.token }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
    const q = await preview(t);
    if (!q.ok) throw new Error(q.error);
    expect(await t.runtime.rfPlan(planReq({ projectId: 'p2', token: q.token }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('refuses when the crops changed since the preview', async () => {
    const t = setup({ photos: true });
    const p = await preview(t);
    if (!p.ok) throw new Error(p.error);
    t.disk.version = 'v2';
    expect(await t.runtime.rfPlan(planReq({ token: p.token }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
  });

  it('refuses an expired token', async () => {
    const t = setup({ photos: true });
    const p = await preview(t);
    if (!p.ok) throw new Error(p.error);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
    expect(await t.runtime.rfPlan(planReq({ token: p.token }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
  });

  it('a forbid policy refuses cloud', async () => {
    const t = setup({ ai: 'forbid', photos: true });
    const r = await t.runtime.rfPlan(planReq({ token: 'x', photos: true }));
    expect(r).toEqual({ ok: false, error: MESSAGES.forbidden });
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('refuses offline-only before anything is sent', async () => {
    const t = setup({ offline: true });
    expect(await t.runtime.rfPlan(planReq())).toEqual({ ok: false, error: MESSAGES.offlineOnly });
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('refuses a second request with the same run id while one is out', async () => {
    const t = setup({ provider: 'local' });
    const a = t.runtime.rfPlan(planReq());
    const b = await t.runtime.rfPlan(planReq());
    expect(b).toEqual({ ok: false, error: MESSAGES.busy });
    expect((await a).ok).toBe(true);
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
    expect((await rt.rfPlan(planReq())).ok).toBe(false);
    expect((await rt.rfPlanPreview({ projectId: 'p1', unitIds: ['ant-1'] })).ok).toBe(false);
  });
});

describe('ai:rfPlan request', () => {
  it('sends one request for the site with the crops when photos are allowed', async () => {
    const t = setup({ photos: true });
    const p = await preview(t);
    if (!p.ok) throw new Error(p.error);
    const r = await t.runtime.rfPlan(planReq({ token: p.token }));
    expect(r).toMatchObject({
      ok: true,
      provider: 'anthropic',
      promptVersion: RF_PLAN_PROMPT_VERSION,
      inputTokens: 1000,
      outputTokens: 100,
      warnings: [],
    });
    expect(ipc['ai:rfPlan'].response.parse(r)).toEqual(r);
    expect(r.ok && r.picks.map((x) => x.unitId)).toEqual(['ant-1', 'ant-2']);
    expect(t.model.doGenerateCalls).toHaveLength(1);
    const s = sent(t);
    expect(s.files).toBe(2);
    expect(s.system).toBe(rfPlanInstructions());
    expect(s.text).toContain('generic-panel-65-17');
    expect(t.recorded).toHaveLength(1);
  });

  it('sends no photo without consent, on the chat route', async () => {
    const t = setup({ photos: false, chatModel: 'claude-sonnet-5' });
    const p = await preview(t);
    if (!p.ok) throw new Error(p.error);
    const r = await t.runtime.rfPlan(planReq({ token: p.token }));
    expect(r).toMatchObject({ ok: true, model: 'claude-sonnet-5' });
    expect(sent(t).files).toBe(0);
  });

  it('photos: true on a text-only preview is refused: the request differs from the preview', async () => {
    const t = setup({ photos: false });
    const p = await preview(t);
    if (!p.ok) throw new Error(p.error);
    expect(await t.runtime.rfPlan(planReq({ token: p.token, photos: true }))).toEqual({
      ok: false,
      error: PREVIEW_FIRST,
    });
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('drops geometry and unknown units from the reply with warnings', async () => {
    const t = setup({
      provider: 'local',
      answer: JSON.stringify({
        picks: [
          {
            unitId: 'ant-1',
            entryId: 'generic-panel-65-17',
            band: 'B3',
            tech: 'lte',
            bandwidthMhz: 20,
            azimuthDeg: 120,
            reason: 'narrow',
            confidence: 'medium',
          },
          {
            unitId: 'ant-9',
            entryId: 'generic-panel-65-17',
            band: 'B3',
            tech: 'lte',
            bandwidthMhz: 20,
            reason: 'narrow',
            confidence: 'low',
          },
        ],
      }),
    });
    const r = await t.runtime.rfPlan(planReq());
    if (!r.ok) throw new Error(r.error);
    expect(r.picks).toHaveLength(1);
    expect(r.picks[0]).not.toHaveProperty('azimuthDeg');
    expect(r.warnings.join(' ')).toMatch(/azimuth/);
    expect(r.warnings.join(' ')).toMatch(/ant-9/);
    expect(r.warnings.join(' ')).toMatch(/ant-2/);
  });

  it('a local provider needs no token, sends photos only with consent, and costs 0', async () => {
    const t = setup({ provider: 'local', photos: false });
    const r = await t.runtime.rfPlan(planReq());
    expect(r).toMatchObject({ ok: true, provider: 'local', costUsd: 0 });
    expect(sent(t).files).toBe(0);
    expect(t.recorded[0]).toMatchObject({ provider: 'local', costUsd: 0 });
    const u = setup({ provider: 'local', photos: false });
    await u.runtime.rfPlan(planReq({ photos: true }));
    expect(sent(u).files).toBe(2);
  });

  it('returns the error of a failed provider call', async () => {
    const t = setup({ provider: 'local', fail: true });
    const r = await t.runtime.rfPlan(planReq());
    expect(r.ok).toBe(false);
  });
});
