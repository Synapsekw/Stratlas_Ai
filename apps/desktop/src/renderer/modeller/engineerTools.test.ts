import { runRendererTool, type RendererToolContext } from '@aio/ai';
import type { AssembleInput } from '@aio/modelling';
import type { Assembly, EngineerProposal, ProcModel } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyOverrides,
  memoryEngineerSession,
  registerEngineerTools,
  type EngineerModelSession,
} from './engineerTools';

const comp = (
  role: string,
  kind: string,
  count: number,
  params: Record<string, number | string | boolean>,
  levels?: number[],
): EngineerProposal['components'][number] => ({
  role,
  kind,
  count,
  units: 'ratio',
  params,
  ...(levels ? { levels } : {}),
  imageIds: ['p1'],
  observed: true,
});

/** A synthetic chimney: shaft, three flues, two intermediate light levels and a crown. */
const proposal: EngineerProposal = {
  family: { value: 'chimney', reasons: ['Synthetic test chimney.'] },
  identity: { sameAsset: true, conflicts: [] },
  components: [
    comp('shaft', 'shaft', 1, { rBase: 0.05, rTop: 0.035, openTop: true, wall: 0.004 }),
    comp('flue', 'flue', 3, { rOuter: 0.008, rInner: 0.006 }),
    comp('light', 'warningLight', 3, { fixture: 'single' }, [0.45, 0.8, 1]),
    comp('ladder', 'ladder', 1, { cage: true, azimuthDeg: 90 }),
  ],
  unresolved: [],
  notes: '',
};

const input: AssembleInput = {
  modelId: 'stack-t',
  runId: 'run-t',
  family: 'chimney',
  scope: 'asset',
  evidence: null,
  proposal,
  setup: {
    sources: { clouds: [], meshes: [], photos: [] },
    family: 'chimney',
    scope: 'asset',
    detail: 'standard',
    placement: 'unplaced',
  },
  user: emptyOverrides(),
  previous: null,
  now: '2026-10-15T00:00:00.000Z',
};

let session: EngineerModelSession | null = null;
beforeAll(() => {
  registerEngineerTools(() => session);
});
beforeEach(() => {
  session = memoryEngineerSession(input);
});

const ctx: RendererToolContext = {
  workspace: createWorkspace(),
  window: 'scene3d',
  scene: () => null,
  fetchJson: () => Promise.resolve(null),
  captureFrame: () => Promise.resolve(null),
  now: () => new Date('2026-10-15T10:00:00Z'),
};
const run = (name: string, args: unknown) => runRendererTool(name, args, ctx);

function model(): ProcModel {
  const m = session?.current()?.model;
  if (!m) throw new Error('no model');
  return m;
}
const ids = (m: ProcModel, prefix: string) =>
  m.assemblies.map((a) => a.id).filter((id) => id.startsWith(prefix));
const byId = (m: ProcModel, id: string): Assembly => {
  const a = m.assemblies.find((x) => x.id === id);
  if (!a) throw new Error(`no ${id}`);
  return a;
};
const params = (a: Assembly) => a.params as Record<string, unknown>;

describe('engineering model correction tools', () => {
  it('list the components with how each value is known', async () => {
    const r = await run('list_components', { kind: 'flue' });
    expect(r.summary).toBe('3 components');
    expect(r.result).toMatchObject({
      components: [
        { id: 'flue-1', role: 'flue', kind: 'flue', status: 'draft' },
        { id: 'flue-2' },
        { id: 'flue-3' },
      ],
    });
  });

  it('set_count flue 4: adds flue-4, keeps every other component and accepted work', async () => {
    await run('edit_component', { component: 'flue-2', status: 'accepted' });
    await run('edit_component', { component: 'ladder-1', status: 'accepted' });
    await run('edit_component', { component: 'flue-1', set: { rOuter: 0.9, rInner: 0.7 } });
    const before = model();
    expect(ids(before, 'flue-')).toEqual(['flue-1', 'flue-2', 'flue-3']);
    const r = await run('set_count', { role: 'flue', count: 4 });
    const after = model();
    expect(ids(after, 'flue-')).toEqual(['flue-1', 'flue-2', 'flue-3', 'flue-4']);
    // every component that is not a flue is the same as before, accepted ones included
    for (const a of before.assemblies.filter((x) => !x.id.startsWith('flue-'))) {
      if ((r.result as { changed: string[] }).changed.includes(a.id)) continue;
      expect(byId(after, a.id)).toEqual(a);
    }
    const changed = (r.result as { changed: string[] }).changed;
    // only the flues change, and the deck at the top, which has an opening per flue; the shaft
    // (whose open top the count decides) keeps its values and how they are known
    expect(changed.filter((id) => !id.startsWith('flue-'))).toEqual(['deck-1']);
    expect(byId(after, 'shaft-1')).toBe(byId(before, 'shaft-1'));
    const deck = byId(after, 'deck-1');
    expect({ ...deck, params: { ...deck.params, openings: null } }).toEqual({
      ...byId(before, 'deck-1'),
      params: { ...byId(before, 'deck-1').params, openings: null },
    });
    expect(byId(after, 'ladder-1')).toEqual(byId(before, 'ladder-1'));
    // the accepted flue stays accepted; the person's values on flue-1 stay
    expect(byId(after, 'flue-2').status).toBe('accepted');
    expect(params(byId(after, 'flue-1'))).toMatchObject({ rOuter: 0.9, rInner: 0.7 });
    expect(byId(after, 'flue-1').quality.rOuter?.basis).toBe('user');
  });

  it('a lower count never drops an accepted flue', async () => {
    await run('edit_component', { component: 'flue-3', status: 'accepted' });
    const accepted = byId(model(), 'flue-3');
    await run('set_count', { role: 'flue', count: 2 });
    const flues = ids(model(), 'flue-');
    expect(flues).toHaveLength(2);
    expect(flues).toContain('flue-3');
    // kept as accepted, values untouched (a review stamp may be added when it is flagged)
    expect({ ...byId(model(), 'flue-3'), reviewed: undefined }).toEqual({
      ...accepted,
      reviewed: undefined,
    });
  });

  it('set_levels for one level changes only that level', async () => {
    const before = model();
    const level = ids(before, 'light-l1-');
    expect(level.length).toBeGreaterThan(0);
    const r = await run('set_levels', { role: 'light-l1', levels: [40] });
    const changed = (r.result as { changed: string[] }).changed;
    expect(changed.sort()).toEqual([...level].sort());
    const after = model();
    for (const a of before.assemblies.filter((x) => !x.id.startsWith('light-l1-')))
      expect(byId(after, a.id)).toEqual(a);
    for (const id of level) expect(byId(after, id).quality.centre?.basis).toBe('user');
  });

  it('set_levels for all intermediate lights adds a level', async () => {
    await run('set_levels', { role: 'light', levels: [25, 45, 80] });
    const levels = new Set(
      model()
        .assemblies.map((a) => /^light-l(\d+)-/.exec(a.id)?.[1])
        .filter(Boolean),
    );
    expect(levels.size).toBe(3);
  });

  it('edit_component refuses values outside the bounds with the schema message', async () => {
    const before = model();
    await expect(
      run('edit_component', { component: 'flue-2', set: { rOuter: -1 } }),
    ).rejects.toThrow(/flue-2 cannot take those values: params\.rOuter: /);
    await expect(
      run('edit_component', { component: 'flue-2', set: { rInner: 0.5, rOuter: 0.1 } }),
    ).rejects.toThrow('Inner radius must be below outer radius.');
    await expect(
      run('edit_component', { component: 'flue-2', set: { wingspan: 3 } }),
    ).rejects.toThrow(/cannot take those values/);
    expect(model()).toBe(before);
  });

  it('remove_component on an accepted component needs confirm', async () => {
    await run('edit_component', { component: 'ladder-1', status: 'accepted' });
    await expect(run('remove_component', { component: 'ladder-1' })).rejects.toThrow(
      'ladder-1 was accepted by a person. Ask them, then remove with confirm: true.',
    );
    expect(ids(model(), 'ladder-')).toEqual(['ladder-1']);
    await run('remove_component', { component: 'ladder-1', confirm: true });
    expect(ids(model(), 'ladder-')).toEqual([]);
  });

  it('remove_component drops a draft role and keeps it gone on the next correction', async () => {
    await run('remove_component', { component: 'ladder' });
    expect(ids(model(), 'ladder-')).toEqual([]);
    await run('set_count', { role: 'flue', count: 4 });
    expect(ids(model(), 'ladder-')).toEqual([]);
  });

  it('add_component adds a checked draft, and refuses one that does not fit its kind', async () => {
    const r = await run('add_component', {
      kind: 'cabinet',
      role: 'cabinet',
      params: { base: [5, 0, 0], size: [1, 2, 1], yawDeg: 0 },
    });
    expect(r.summary).toMatch(/^Added cabinet-1/);
    expect(byId(model(), 'cabinet-1')).toMatchObject({ status: 'draft', origin: { by: 'agent' } });
    await expect(
      run('add_component', { kind: 'cabinet', role: 'cabinet', params: { base: [5, 0] } }),
    ).rejects.toThrow(/A cabinet cannot take those values/);
  });

  it('says so when no engineering model is open', async () => {
    session = null;
    await expect(run('set_count', { role: 'flue', count: 4 })).rejects.toThrow(
      'No engineering model is open in the Model builder.',
    );
  });
});
