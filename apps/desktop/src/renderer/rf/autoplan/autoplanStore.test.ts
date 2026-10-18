// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AntennaUnit, RfCatalogueEntry, RfRun } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antennaStore } from '../../telecom/antennaStore';
import { antennasFile, unit } from '../__fixtures__/rfData';
import { startRfRun } from '../rfTab';
import { loadRf, resetRf, rfStore, type RfClassStat, type RfState } from '../rfStore';
import {
  AUTOPLAN_MESSAGES,
  applyAutoplan,
  autoplanStore,
  canAutoplan,
  cancelAutoplan,
  confirmSend,
  openAntennaReviewOrFallback,
  resetAutoplan,
  selectChipState,
  startAutoplan,
  switchSource,
  type AutoplanState,
} from './autoplanStore';

type Handler = (req: Record<string, unknown>) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (req: Record<string, unknown>) => unknown>(),
  calls: new Array<[string, Record<string, unknown>]>(),
}));

vi.mock('../../shell', () => ({
  bridge: {
    call: vi.fn(async (channel: string, req: Record<string, unknown>) => {
      h.calls.push([channel, req]);
      const f = h.handlers.get(channel);
      if (!f) return { ok: false, error: `unexpected ${channel}` };
      return { ok: true, value: await f(req) };
    }),
  },
  jobs: {},
}));

vi.mock('../rfTab', () => ({
  startRfRun: vi.fn(() => Promise.resolve({ ok: true, jobId: 'job-1', runId: 'rf-1' })),
}));

const CATALOGUE = (
  JSON.parse(
    // from this file, not the working folder (jsdom gives import.meta.url a non-file scheme)
    readFileSync(
      resolve(import.meta.dirname, '../../../../../../packages/rf/catalogue/generic.json'),
      'utf8',
    ),
  ) as { entries: RfCatalogueEntry[] }
).entries;

const autoplan = () => autoplanStore.getState();
const callsTo = (channel: string) => h.calls.filter(([c]) => c === channel);

const panel = (id: string, az: number) => unit(id, az);
const draft = (id: string, az: number) => unit(`ant-${id}`, az, { status: 'draft' });
const site3 = (): AntennaUnit[] => [panel('ant-a', 0), panel('ant-b', 120), panel('ant-c', 240)];

function mockInvoke(channel: string, value: unknown): void {
  h.handlers.set(channel, typeof value === 'function' ? (value as Handler) : () => value);
}

async function seedAntennas(units: AntennaUnit[]): Promise<void> {
  mockInvoke('telecom:readAntennas', { ok: true, file: antennasFile(units), readOnly: false });
  mockInvoke('rf:readSectors', { ok: true, file: null, readOnly: false, orphans: [] });
  mockInvoke('rf:listCatalogue', {
    ok: true,
    entries: CATALOGUE.map((entry) => ({ origin: 'builtin', entry })),
    warnings: [],
  });
  mockInvoke('rf:listRuns', { ok: true, runs: [] });
  await loadRf('p1');
  antennaStore.setState({
    projectId: 'p1',
    root: 'C:/proj',
    status: 'ready',
    file: antennasFile(units),
  });
}

const PREVIEW = {
  ok: true,
  provider: 'cloud-x',
  model: 'model-x',
  cloud: true,
  photosAllowed: false,
  crops: [],
  estimate: { inputTokens: 1200, costUsd: 0.01 },
  token: 'tok-1',
};

const REPLY = {
  ok: true,
  provider: 'cloud-x',
  model: 'model-x',
  promptVersion: 'rf-plan-1',
  picks: [
    {
      unitId: 'ant-a',
      entryId: 'generic-aau-64t64r-n78',
      band: 'n78',
      tech: 'nr',
      bandwidthMhz: 100,
      reason: 'Wide deep face',
      confidence: 'high',
    },
  ],
  inputTokens: 1000,
  outputTokens: 100,
  warnings: ['dropped a geometry key'],
};

beforeEach(async () => {
  h.handlers.clear();
  h.calls = [];
  vi.mocked(startRfRun).mockClear();
  resetRf();
  resetAutoplan();
  antennaStore.setState({
    projectId: null,
    root: null,
    status: 'idle',
    file: null,
    selected: null,
  });
  workspace.setState({ project: { id: 'p1', root: 'C:/proj' } as never });
  mockInvoke('ai:status', { ready: false, reason: 'no-provider', cloud: true });
  mockInvoke('ai:cancel', { ok: true });
  await seedAntennas(site3());
});

afterEach(() => {
  workspace.setState({ project: null });
});

describe('startAutoplan', () => {
  it('blocks with review-first when nothing is accepted', async () => {
    await seedAntennas([draft('d1', 0)]);
    await startAutoplan('rules');
    expect(autoplan().phase).toBe('blocked-review');
    expect(autoplan().proposal).toBeNull();
  });

  it('rules source goes straight to review', async () => {
    await startAutoplan('rules');
    expect(autoplan().phase).toBe('review');
    expect(autoplan().source).toBe('rules');
    expect(autoplan().proposal?.rows).toHaveLength(3);
    expect(autoplan().proposal?.rows.every((r) => r.picks[0]?.by === 'rules')).toBe(true);
    expect(callsTo('ai:rfPlanPreview')).toHaveLength(0);
  });

  it('plans the accepted units and lists the drafts as left out', async () => {
    await seedAntennas([...site3(), draft('d1', 60)]);
    await startAutoplan('rules');
    expect(
      autoplan()
        .proposal?.rows.map((r) => r.unitId)
        .sort(),
    ).toEqual(['ant-a', 'ant-b', 'ant-c']);
    expect(autoplan().proposal?.leftOut).toEqual([{ unitId: 'ant-d1', reason: 'draft' }]);
  });

  it('defaults to rules when no provider is set up, and to ai when one is', async () => {
    await startAutoplan();
    expect(autoplan()).toMatchObject({ source: 'rules', phase: 'review', aiAvailable: false });

    mockInvoke('ai:status', { ready: true, cloud: true });
    mockInvoke('ai:rfPlanPreview', PREVIEW);
    await startAutoplan();
    expect(autoplan()).toMatchObject({ source: 'ai', phase: 'preview', aiAvailable: true });
    expect(callsTo('ai:status').at(-1)?.[1]).toEqual({ projectId: 'p1', task: 'chat' });
  });

  it('uses a cell export when one is given', async () => {
    await startAutoplan({ csvText: 'antenna,band,bandwidth\nA,B1,10\nZZ,B3,20' });
    expect(autoplan().phase).toBe('review');
    const rowA = autoplan().proposal?.rows.find((r) => r.unitId === 'ant-a');
    expect(rowA?.picks[0]).toMatchObject({
      by: 'export',
      carrier: { band: 'B1', bandwidthMhz: 10 },
    });
    expect(autoplan().proposal?.unmatchedRows).toEqual([3]);
    expect(autoplan().warnings).toEqual(['No export row for B', 'No export row for C']);
  });

  it('refuses on a read-only project: nothing is planned or asked', async () => {
    rfStore.setState({ readOnly: true });
    h.calls = [];
    await startAutoplan('rules');
    expect(autoplan().phase).toBe('idle');
    expect(autoplan().proposal).toBeNull();
    await startAutoplan('ai');
    expect(autoplan().phase).toBe('idle');
    expect(callsTo('ai:rfPlanPreview')).toHaveLength(0);
  });

  it('leaves out a unit switched off in RF, with the reason inactive', async () => {
    rfStore.setState({
      sectors: {
        ...rfStore.getState().sectors,
        antennas: [{ antennaId: 'ant-b', active: false, carriers: [] }],
      },
    });
    await startAutoplan('rules');
    expect(
      autoplan()
        .proposal?.rows.map((r) => r.unitId)
        .sort(),
    ).toEqual(['ant-a', 'ant-c']);
    expect(autoplan().proposal?.leftOut).toEqual([{ unitId: 'ant-b', reason: 'inactive' }]);
  });

  it('a cell export lists no row missing for a unit it would not plan', async () => {
    await seedAntennas([...site3(), draft('d1', 60)]);
    await startAutoplan({ csvText: 'antenna,band\nA,B1\nB,B1\nC,B1' });
    expect(autoplan().warnings).toEqual([]);
  });

  it('a cell export it cannot read ends in error with rules offered', async () => {
    await startAutoplan({ csvText: 'band\nB3' });
    expect(autoplan().phase).toBe('error');
    expect(autoplan().error).toBeTruthy();
    await switchSource('rules');
    expect(autoplan().phase).toBe('review');
  });
});

describe('the AI source', () => {
  beforeEach(() => {
    mockInvoke('ai:status', { ready: true, cloud: true });
    mockInvoke('ai:rfPlanPreview', PREVIEW);
  });

  it('ai source asks for a preview, then thinks, then reviews', async () => {
    let during: string | null = null;
    mockInvoke('ai:rfPlan', () => {
      during = autoplan().phase;
      return REPLY;
    });
    await startAutoplan('ai');
    expect(autoplan().phase).toBe('preview');
    expect(autoplan().preview).toMatchObject({ ok: true, token: 'tok-1' });
    expect(callsTo('ai:rfPlanPreview')[0]?.[1]).toEqual({
      projectId: 'p1',
      unitIds: ['ant-a', 'ant-b', 'ant-c'],
    });
    expect(callsTo('ai:rfPlan')).toHaveLength(0);

    await confirmSend(false);
    expect(during).toBe('thinking');
    const req = callsTo('ai:rfPlan')[0]?.[1] as {
      token?: string;
      photos?: boolean;
      units: { unitId: string; widthM?: number; depthM?: number; downtiltDeg?: number }[];
      catalogue: { id: string; bands: string[] }[];
    };
    expect(req.token).toBe('tok-1');
    expect(req.photos).toBeUndefined();
    expect(req.units.map((u) => u.unitId)).toEqual(['ant-a', 'ant-b', 'ant-c']);
    expect(req.units[0]).toMatchObject({ widthM: 0.3, depthM: 0.15, downtiltDeg: 4 });
    expect(req.catalogue.find((c) => c.id === 'generic-aau-64t64r-n78')?.bands).toContain('n78');
    expect(req.catalogue.find((c) => c.id === 'generic-rru-4t4r-4x40w')?.bands).toContain('B3');

    expect(autoplan().phase).toBe('review');
    expect(autoplan().preview).toBeNull();
    const rows = autoplan().proposal?.rows ?? [];
    expect(rows.find((r) => r.unitId === 'ant-a')?.picks[0]).toMatchObject({
      by: 'ai',
      confidence: 'high',
    });
    // a unit the AI left out gets the rules pick, at low confidence, saying why
    expect(rows.find((r) => r.unitId === 'ant-b')?.picks[0]).toMatchObject({
      by: 'rules',
      confidence: 'low',
    });
    expect(rows.find((r) => r.unitId === 'ant-b')?.picks[0]?.reason).toMatch(/AI/);
    expect(autoplan().warnings).toContain('dropped a geometry key');
  });

  it('never sends a unit switched off in RF to the AI', async () => {
    rfStore.setState({
      sectors: {
        ...rfStore.getState().sectors,
        antennas: [{ antennaId: 'ant-b', active: false, carriers: [] }],
      },
    });
    mockInvoke('ai:rfPlan', REPLY);
    await startAutoplan('ai');
    expect(callsTo('ai:rfPlanPreview')[0]?.[1]).toEqual({
      projectId: 'p1',
      unitIds: ['ant-a', 'ant-c'],
    });
    await confirmSend(false);
    const req = callsTo('ai:rfPlan')[0]?.[1] as { units: { unitId: string }[] };
    expect(req.units.map((u) => u.unitId)).toEqual(['ant-a', 'ant-c']);
  });

  it('a failed AI call ends in error with rules offered, never stuck in thinking', async () => {
    mockInvoke('ai:rfPlan', { ok: false, error: 'timeout' });
    await startAutoplan('ai');
    await confirmSend(false);
    expect(autoplan().phase).toBe('error');
    expect(autoplan().error).toBe('timeout');
    expect(autoplan().preview).toBeNull();
    expect(selectChipState(rfStore.getState(), site3(), autoplan()).kind).not.toBe('planning');
    await switchSource('rules');
    expect(autoplan().phase).toBe('review');
    expect(autoplan().error).toBeNull();
  });

  it('a thrown bridge call also ends in error', async () => {
    mockInvoke('ai:rfPlan', () => {
      throw new Error('boom');
    });
    await startAutoplan('ai');
    await confirmSend(false);
    expect(autoplan().phase).toBe('error');
    expect(autoplan().error).toBe('boom');
  });

  it('a refused preview ends in error with rules offered', async () => {
    mockInvoke('ai:rfPlanPreview', { ok: false, error: 'The project forbids AI' });
    await startAutoplan('ai');
    expect(autoplan()).toMatchObject({ phase: 'error', error: 'The project forbids AI' });
    expect(callsTo('ai:rfPlan')).toHaveLength(0);
  });

  it('a local model needs no send preview', async () => {
    mockInvoke('ai:rfPlanPreview', { ...PREVIEW, cloud: false });
    mockInvoke('ai:rfPlan', REPLY);
    await startAutoplan('ai');
    expect(autoplan().phase).toBe('review');
    expect(callsTo('ai:rfPlan')).toHaveLength(1);
  });

  it('cancel at the preview leaves idle and writes nothing', async () => {
    await startAutoplan('ai');
    expect(autoplan().phase).toBe('preview');
    cancelAutoplan();
    expect(autoplan()).toMatchObject({ phase: 'idle', preview: null, proposal: null });
    await confirmSend(false);
    expect(callsTo('ai:rfPlan')).toHaveLength(0);
    expect(rfStore.getState().dirty).toBe(false);
    expect(rfStore.getState().sectors.sectors).toHaveLength(0);
  });

  it('cancel while thinking stops the run and ignores a late reply', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockInvoke('ai:rfPlan', () => new Promise((r) => (release = r)));
    await startAutoplan('ai');
    const sending = confirmSend(false);
    await vi.waitFor(() => {
      expect(callsTo('ai:rfPlan')).toHaveLength(1);
    });
    expect(autoplan().phase).toBe('thinking');
    cancelAutoplan();
    expect(autoplan().phase).toBe('idle');
    const runId = (callsTo('ai:rfPlan')[0]?.[1] as { runId: string }).runId;
    expect(callsTo('ai:cancel')[0]?.[1]).toEqual({ runId });
    release(REPLY);
    await sending;
    expect(autoplan()).toMatchObject({ phase: 'idle', proposal: null });
    expect(selectChipState(rfStore.getState(), site3(), autoplan()).kind).not.toBe('planning');
  });

  it('a second start while thinking cancels the first request and ignores its reply', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockInvoke('ai:rfPlan', () => new Promise((r) => (release = r)));
    await startAutoplan('ai');
    const sending = confirmSend(false);
    await vi.waitFor(() => {
      expect(callsTo('ai:rfPlan')).toHaveLength(1);
    });
    const runId = (callsTo('ai:rfPlan')[0]?.[1] as { runId: string }).runId;
    await startAutoplan('rules');
    expect(callsTo('ai:cancel')[0]?.[1]).toEqual({ runId });
    expect(autoplan().phase).toBe('review');
    const rulesProposal = autoplan().proposal;
    release(REPLY);
    await sending;
    expect(autoplan().phase).toBe('review');
    expect(autoplan().proposal).toBe(rulesProposal);
    expect(autoplan().proposal?.rows.every((r) => r.picks[0]?.by === 'rules')).toBe(true);
  });

  it('knows the provider from the status, and keeps it when a local model skips the preview', async () => {
    mockInvoke('ai:status', {
      ready: true,
      route: { task: 'chat', provider: 'local', model: 'local-x' },
    });
    mockInvoke('ai:rfPlanPreview', { ...PREVIEW, provider: 'local', cloud: false });
    mockInvoke('ai:rfPlan', REPLY);
    let during: { provider: string | null; cloud: boolean | null } | null = null;
    const unsub = autoplanStore.subscribe((s) => {
      if (s.phase === 'thinking') during = { provider: s.provider, cloud: s.cloud };
    });
    await startAutoplan();
    unsub();
    expect(during).toEqual({ provider: 'local', cloud: false });
    expect(autoplan()).toMatchObject({ phase: 'review', provider: 'local', cloud: false });
    cancelAutoplan();
    expect(autoplan()).toMatchObject({ phase: 'idle', provider: 'local', cloud: false });
  });

  it('takes the provider from the send preview, and forgets it on a project switch', async () => {
    await startAutoplan('ai');
    expect(autoplan()).toMatchObject({ phase: 'preview', provider: 'cloud-x', cloud: true });
    await loadRf('p2');
    expect(autoplan()).toMatchObject({ provider: null, cloud: null, aiAvailable: false });
  });

  it('a project switch while the preview is pending drops it (R17)', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockInvoke('ai:rfPlanPreview', () => new Promise((r) => (release = r)));
    const starting = startAutoplan('ai');
    await vi.waitFor(() => {
      expect(callsTo('ai:rfPlanPreview')).toHaveLength(1);
    });
    expect(autoplan()).toMatchObject({ phase: 'preview', projectId: 'p1' });
    await loadRf('p2');
    expect(autoplan()).toMatchObject({ phase: 'idle', projectId: null, preview: null });
    release(PREVIEW);
    await starting;
    expect(autoplan()).toMatchObject({ phase: 'idle', preview: null, proposal: null });
    expect(selectChipState(rfStore.getState(), site3(), autoplan()).kind).not.toBe('planning');
    await confirmSend(false);
    expect(callsTo('ai:rfPlan')).toHaveLength(0);
    expect(await applyAutoplan(true)).toBeNull();
    expect(rfStore.getState().dirty).toBe(false);
    expect(vi.mocked(startRfRun)).not.toHaveBeenCalled();
  });

  it('a project switch while thinking drops the reply (R17)', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockInvoke('ai:rfPlan', () => new Promise((r) => (release = r)));
    await startAutoplan('ai');
    const sending = confirmSend(false);
    await vi.waitFor(() => {
      expect(callsTo('ai:rfPlan')).toHaveLength(1);
    });
    await loadRf('p2');
    expect(callsTo('ai:cancel')).toHaveLength(1);
    release(REPLY);
    await sending;
    expect(autoplan()).toMatchObject({ phase: 'idle', proposal: null });
  });
});

describe('applyAutoplan', () => {
  it('refuses a proposal made for another project (R17)', async () => {
    await startAutoplan('rules');
    autoplanStore.setState({ projectId: 'p-other' });
    expect(await applyAutoplan(true)).toBeNull();
    expect(rfStore.getState().dirty).toBe(false);
    expect(rfStore.getState().sectors.sectors).toHaveLength(0);
    expect(vi.mocked(startRfRun)).not.toHaveBeenCalled();
    expect(autoplan().phase).toBe('idle');
  });

  it('applies and says why no run started when the project folder is not known', async () => {
    await startAutoplan('rules');
    workspace.setState({ project: null });
    expect(await applyAutoplan(true)).toEqual({
      ok: false,
      code: 'failed',
      message: AUTOPLAN_MESSAGES.noRoot,
    });
    expect(rfStore.getState().dirty).toBe(true);
    expect(vi.mocked(startRfRun)).not.toHaveBeenCalled();
  });

  it('applyAutoplan(true) applies and starts a run', async () => {
    await startAutoplan('rules');
    const r = await applyAutoplan(true);
    expect(r).toEqual({ ok: true, jobId: 'job-1', runId: 'rf-1' });
    expect(vi.mocked(startRfRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startRfRun)).toHaveBeenCalledWith('C:/proj');
    expect(rfStore.getState().sectors.sectors).toHaveLength(3);
    expect(rfStore.getState().sectors.antennas).toHaveLength(3);
    expect(autoplan().phase).toBe('idle');
  });

  it('applyAutoplan(false) applies, leaves it unsaved and runs nothing', async () => {
    await startAutoplan('rules');
    expect(await applyAutoplan(false)).toBeNull();
    expect(vi.mocked(startRfRun)).not.toHaveBeenCalled();
    expect(rfStore.getState().dirty).toBe(true);
    expect(callsTo('rf:writeSectors')).toHaveLength(0);
  });

  it('on a read-only project applies nothing and says so', async () => {
    await startAutoplan('rules');
    rfStore.setState({ readOnly: true });
    expect(await applyAutoplan(true)).toEqual({ ok: false, code: 'read-only' });
    expect(rfStore.getState().dirty).toBe(false);
    expect(rfStore.getState().sectors.sectors).toHaveLength(0);
    expect(vi.mocked(startRfRun)).not.toHaveBeenCalled();
    expect(autoplan().phase).toBe('idle');
  });

  it('does nothing without a proposal in review', async () => {
    expect(await applyAutoplan(true)).toBeNull();
    expect(rfStore.getState().dirty).toBe(false);
    expect(vi.mocked(startRfRun)).not.toHaveBeenCalled();
  });
});

describe('openAntennaReviewOrFallback', () => {
  const bench = () => {
    const open = vi.fn();
    return { open, store: { getState: () => ({ open }) } as never };
  };
  const drafts = () => [...site3(), draft('d1', 60), draft('d2', 90)];

  it('opens the antenna review once the inventory is read', async () => {
    await seedAntennas(drafts());
    const before = antennaStore.getState().reveal;
    const b = bench();
    openAntennaReviewOrFallback(b.store);
    // the drafts, the first one revealed; the bench is left as it is
    expect(antennaStore.getState()).toMatchObject({ filter: 'draft', selected: 'ant-d1' });
    expect(antennaStore.getState().reveal).toBe(before + 1);
    expect(b.open).not.toHaveBeenCalled();
  });

  it('opens the Measure bench while the inventory loads, then the review once, when it is read', async () => {
    await seedAntennas(drafts());
    antennaStore.setState({ status: 'loading', selected: null, filter: 'all' });
    const b = bench();
    openAntennaReviewOrFallback(b.store);
    expect(b.open).toHaveBeenCalledWith('measure');
    expect(antennaStore.getState().selected).toBeNull();
    antennaStore.setState({ status: 'ready' });
    expect(antennaStore.getState()).toMatchObject({ filter: 'draft', selected: 'ant-d1' });
    // one shot: a later read opens nothing again
    antennaStore.setState({ selected: null, status: 'loading' });
    antennaStore.setState({ status: 'ready' });
    expect(antennaStore.getState().selected).toBeNull();
  });

  it('drops the waiting review on a failed read, a read of another project or a newer ask', async () => {
    await seedAntennas(drafts());
    const b = bench();
    // a failed read
    antennaStore.setState({ status: 'loading', selected: null });
    openAntennaReviewOrFallback(b.store);
    antennaStore.setState({ status: 'error' });
    antennaStore.setState({ status: 'ready' });
    expect(antennaStore.getState().selected).toBeNull();
    // another project's inventory
    antennaStore.setState({ status: 'loading', projectId: 'p1' });
    openAntennaReviewOrFallback(b.store);
    antennaStore.setState({ status: 'ready', projectId: 'p2' });
    expect(antennaStore.getState().selected).toBeNull();
    // a newer ask replaces the waiting one: the review opens once
    antennaStore.setState({ status: 'loading', projectId: 'p1' });
    openAntennaReviewOrFallback(b.store);
    openAntennaReviewOrFallback(b.store);
    const before = antennaStore.getState().reveal;
    antennaStore.setState({ status: 'ready' });
    expect(antennaStore.getState().selected).toBe('ant-d1');
    expect(antennaStore.getState().reveal).toBe(before + 1);
    expect(b.open).toHaveBeenCalledTimes(4);
  });
});

describe('selectChipState', () => {
  const STATS: RfClassStat[] = [
    { cls: 'excellent', areaM2: 0, share: 0 },
    { cls: 'good', areaM2: 4, share: 0.04 },
    { cls: 'fair', areaM2: 13, share: 0.13 },
    { cls: 'poor', areaM2: 50, share: 0.5 },
    { cls: 'none', areaM2: 33, share: 0.33 },
  ];
  const units3 = site3();
  const idle: AutoplanState = {
    phase: 'idle',
    source: 'rules',
    preview: null,
    proposal: null,
    warnings: [],
    error: null,
    projectId: null,
    aiAvailable: false,
    provider: null,
    cloud: null,
  };
  const RUN = { runId: 'rf-1', createdAt: '2026-10-18T08:17:00Z' } as RfRun;
  const planned = {
    schema: 'aio.rf-sectors/1',
    sectors: [
      { id: 'sec-s1', name: 'S1', antennaIds: ['ant-a'] },
      { id: 'sec-s2', name: 'S2', antennaIds: ['ant-b', 'ant-c'] },
    ],
    antennas: ['ant-a', 'ant-b', 'ant-c'].map((antennaId) => ({
      antennaId,
      active: true,
      equipment: { kind: 'aau', aau: 'generic-aau-64t64r-n78' },
      carriers: [{ id: 'c1', tech: 'nr', band: 'n78', bandwidthMhz: 100, feederLossDb: 0 }],
    })),
  } as unknown as RfState['sectors'];

  function rf(o: {
    runs?: RfRun[];
    sectorsN?: number;
    classStats?: RfClassStat[];
    dirty?: boolean;
    running?: boolean;
  }): RfState {
    const s = rfStore.getState();
    const withRun = o.classStats !== undefined;
    return {
      ...s,
      runs: o.runs ?? (withRun ? [RUN] : []),
      selectedRunId: withRun ? RUN.runId : null,
      classStats: o.classStats ?? null,
      sectors: o.sectorsN === 0 ? { ...planned, sectors: [], antennas: [] } : planned,
      dirty: o.dirty ?? false,
      running: o.running ?? false,
    };
  }

  it('chip state follows the store', () => {
    expect(selectChipState(rf({ runs: [], sectorsN: 0 }), units3, idle)).toEqual({
      kind: 'not-planned',
      accepted: 3,
    });
    expect(selectChipState(rf({ classStats: STATS }), units3, idle)).toMatchObject({
      kind: 'result',
      view: 'rsrp',
      fairOrBetterPct: 17,
      at: '2026-10-18T08:17:00Z',
    });
  });

  it('is hidden without antennas and asks for a review when none is accepted', () => {
    expect(selectChipState(rf({}), null, idle)).toEqual({ kind: 'hidden' });
    expect(selectChipState(rf({}), [], idle)).toEqual({ kind: 'hidden' });
    const drafts = [draft('d1', 0), draft('d2', 90), draft('d3', 180), draft('d4', 270)];
    expect(selectChipState(rf({ sectorsN: 0 }), drafts, idle)).toEqual({
      kind: 'review-first',
      total: 4,
    });
  });

  it('is ready when planned and not run, or edited since the run', () => {
    expect(selectChipState(rf({}), units3, idle)).toEqual({ kind: 'ready', sectors: 2 });
    expect(selectChipState(rf({ classStats: STATS, dirty: true }), units3, idle)).toEqual({
      kind: 'ready',
      sectors: 2,
    });
  });

  it('is ready once the planned units are set up, whatever drafts, rejected or inactive members lack', () => {
    const s = rf({});
    const units = [
      ...units3,
      unit('ant-d', 0, { status: 'draft' }),
      unit('ant-r', 120, { status: 'rejected' }),
      unit('ant-o', 240),
    ];
    const withOthers = {
      ...s,
      sectors: {
        ...s.sectors,
        sectors: s.sectors.sectors.map((x, i) =>
          i === 0 ? { ...x, antennaIds: [...x.antennaIds, 'ant-d', 'ant-r', 'ant-o'] } : x,
        ),
        // ant-o is switched off in RF and has nothing set up
        antennas: [...s.sectors.antennas, { antennaId: 'ant-o', active: false, carriers: [] }],
      },
    };
    expect(selectChipState(withOthers, units, idle)).toEqual({ kind: 'ready', sectors: 2 });
    // only drafts and the like in the sectors: nothing is planned yet
    const onlyDraft = {
      ...s,
      sectors: { ...s.sectors, sectors: [{ id: 'sec-s1', name: 'S1', antennaIds: ['ant-d'] }] },
    };
    expect(selectChipState(onlyDraft, units, idle).kind).toBe('not-planned');
  });

  it('is ready, not the old result, once the plan was saved again after the run', () => {
    const s = rf({ classStats: STATS });
    expect(selectChipState(s, units3, idle).kind).toBe('result');
    expect(selectChipState({ ...s, planChangedSinceRun: true }, units3, idle)).toEqual({
      kind: 'ready',
      sectors: 2,
    });
  });

  it('offers Auto-plan where the chip does, never on a read-only project', () => {
    for (const kind of ['not-planned', 'ready', 'result'] as const) {
      const chip = { kind } as Parameters<typeof canAutoplan>[0];
      expect(canAutoplan(chip, false)).toBe(true);
      expect(canAutoplan(chip, true)).toBe(false);
    }
    for (const kind of ['hidden', 'review-first', 'planning', 'running'] as const)
      expect(canAutoplan({ kind } as Parameters<typeof canAutoplan>[0], false)).toBe(false);
  });

  it('is not planned while a planned unit lacks equipment or a carrier', () => {
    const s = rf({});
    const missing = {
      ...s,
      sectors: {
        ...s.sectors,
        antennas: s.sectors.antennas.map((a) =>
          a.antennaId === 'ant-c' ? { ...a, carriers: [] } : a,
        ),
      },
    };
    expect(selectChipState(missing, units3, idle).kind).toBe('not-planned');
  });

  it('shows running and planning over everything else', () => {
    expect(selectChipState(rf({ classStats: STATS, running: true }), units3, idle).kind).toBe(
      'running',
    );
    for (const phase of ['preview', 'thinking'] as const)
      expect(selectChipState(rf({}), units3, { ...idle, phase }).kind).toBe('planning');
    for (const phase of ['review', 'error', 'blocked-review'] as const)
      expect(selectChipState(rf({}), units3, { ...idle, phase }).kind).toBe('ready');
  });
});
