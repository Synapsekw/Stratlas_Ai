import { describe, expect, it } from 'vitest';
import { AiTask } from './agent';
import { DETAIL_BUDGETS, EngineerProposal, EngineerRun } from './engineer';

const comp = {
  role: 'flue',
  kind: 'flue',
  count: 4,
  units: 'ratio',
  params: { heightRatio: 0.03 },
  imageIds: ['img-3'],
  observed: true,
};

const proposal = (components: unknown[]) => ({
  family: { value: 'chimney', reasons: [] },
  identity: { sameAsset: true, conflicts: [] },
  components,
  unresolved: [],
  notes: '',
});

describe('EngineerProposal', () => {
  it('accepts a bounded proposal', () => {
    expect(
      EngineerProposal.safeParse({
        family: { value: 'chimney', reasons: ['tall tapered shaft'] },
        identity: { sameAsset: true, conflicts: [] },
        components: [comp],
        unresolved: [],
        notes: '',
      }).success,
    ).toBe(true);
  });
  it('refuses more than 120 components and counts above 64', () => {
    expect(EngineerProposal.safeParse(proposal(Array(121).fill(comp))).success).toBe(false);
    expect(EngineerProposal.safeParse(proposal([{ ...comp, count: 65 }])).success).toBe(false);
  });
  it('refuses geometry arrays in params', () => {
    expect(
      EngineerProposal.safeParse(proposal([{ ...comp, params: { vertices: [1, 2, 3] } }])).success,
    ).toBe(false);
  });
  it('refuses a component without units and accepts metres', () => {
    const noUnits: Record<string, unknown> = { ...comp };
    delete noUnits.units;
    expect(EngineerProposal.safeParse(proposal([noUnits])).success).toBe(false);
    expect(EngineerProposal.safeParse(proposal([{ ...comp, units: 'm' }])).success).toBe(true);
    expect(EngineerProposal.safeParse(proposal([{ ...comp, units: 'ft' }])).success).toBe(false);
  });
  it('refuses more than 24 params on one component', () => {
    const params = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${String(i)}`, i]));
    expect(EngineerProposal.safeParse(proposal([{ ...comp, params }])).success).toBe(false);
  });
});

describe('DETAIL_BUDGETS', () => {
  it('budgets per detail match the spec', () => {
    expect(DETAIL_BUDGETS.fast).toEqual({ triangles: 150_000, costUsd: 0.5, passes: 1 });
    expect(DETAIL_BUDGETS.standard).toEqual({ triangles: 400_000, costUsd: 2, passes: 2 });
    expect(DETAIL_BUDGETS.detailed).toEqual({ triangles: 900_000, costUsd: 5, passes: 3 });
  });
});

describe('EngineerRun', () => {
  const run = (stages: Record<string, unknown>) => ({
    schema: 'aio.engineer-run/1',
    id: 'run-1',
    modelId: 'eng-1',
    createdAt: '2026-10-15T00:00:00Z',
    setup: {
      sources: { clouds: [], meshes: [], photos: [{ path: 'a.jpg' }] },
      family: 'auto',
      scope: 'asset',
      detail: 'standard',
      placement: 'unplaced',
    },
    stages,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
  });

  it('a run with only its first stage recorded parses', () => {
    const r = EngineerRun.safeParse(run({ inspect: { status: 'done', hash: 'h' } }));
    expect(r.success).toBe(true);
    expect(r.data?.stages.estimate).toBeUndefined();
  });
  it('refuses an unknown stage name', () => {
    expect(EngineerRun.safeParse(run({ polish: { status: 'done' } })).success).toBe(false);
  });
  it('needs an anchor point when placement is anchor', () => {
    const r = run({});
    const anchored = (anchor?: number[]) => ({
      ...r,
      setup: { ...r.setup, placement: 'anchor', ...(anchor ? { anchor } : {}) },
    });
    expect(EngineerRun.safeParse(anchored()).success).toBe(false);
    expect(EngineerRun.safeParse(anchored([1, 0, 2])).success).toBe(true);
  });
  it('bounds ids, times and layer names', () => {
    const r = run({});
    expect(EngineerRun.safeParse({ ...r, id: 'nope' }).success).toBe(false);
    expect(EngineerRun.safeParse({ ...r, createdAt: 'yesterday' }).success).toBe(false);
    const clouds = [{ layer: 'x'.repeat(129) }];
    expect(
      EngineerRun.safeParse({
        ...r,
        setup: { ...r.setup, sources: { ...r.setup.sources, clouds } },
      }).success,
    ).toBe(false);
  });
  it('refuses more than 4 clouds in the setup', () => {
    const r = run({});
    const clouds = Array.from({ length: 5 }, (_, i) => ({ layer: `c${String(i)}` }));
    expect(
      EngineerRun.safeParse({
        ...r,
        setup: { ...r.setup, sources: { ...r.setup.sources, clouds } },
      }).success,
    ).toBe(false);
  });
});

describe('AiTask', () => {
  it('appends engineer after the existing tasks', () => {
    expect(AiTask.options).toEqual(['chat', 'vision', 'report', 'extract', 'build', 'engineer']);
  });
});
