import { describe, expect, it, vi } from 'vitest';
import { createFarNotice, farLayers, freshLayerIds, planGap, recentreTarget } from './farContent';

const box = (x: number, z: number, s = 50) =>
  ({ min: [x - s, 0, z - s], max: [x + s, 20, z + s] }) as const;

describe('far rule', () => {
  it('measures plan gaps between boxes, 0 when they overlap', () => {
    expect(planGap(box(0, 0), box(0, 0))).toBe(0);
    expect(planGap(box(0, 0), box(1100, 0))).toBe(1000);
  });
  it('a new layer far from the origin and every older layer is far', () => {
    const ex = [
      { layerId: 'photos', ...box(0, 0) },
      { layerId: 'cloud', ...box(91_000, -2_000) },
    ];
    const far = farLayers(ex, new Set(['photos']));
    expect(far.map((f) => f.layerId)).toEqual(['cloud']);
    expect(far[0]?.distanceM).toBeCloseTo(Math.hypot(90_950, 1_950), 0);
  });
  it('a new section next to an older one is not far, wherever the origin is', () => {
    const ex = [
      { layerId: 'old', ...box(15_000, 0) },
      { layerId: 'new', ...box(16_000, 0) },
    ];
    expect(farLayers(ex, new Set(['old']))).toEqual([]);
  });
  it('two far layers of one site make one notice and one target', () => {
    const ex = [
      { layerId: 'cloud', ...box(30_000, 0) },
      { layerId: 'mesh', ...box(30_020, 10, 5) },
    ];
    const far = farLayers(ex, new Set());
    expect(far.map((f) => f.layerId)).toEqual(['cloud', 'mesh']);
    expect(recentreTarget(far, [500_000, 3_200_000, 20])).toEqual([530_000, 3_200_000]);
  });
});

describe('notice', () => {
  const project = {
    id: 'p',
    root: '/p',
    manifest: {
      origin: [500_000, 3_200_000, 20] as [number, number, number],
      layers: [
        { kind: 'pointcloud', id: 'cloud', name: 'Cloud' },
        { kind: 'photos', id: 'photos', name: 'Photos' },
      ],
    },
  };
  const deps = (blockers: string[] = []) => {
    const call = vi.fn((channel: string) =>
      Promise.resolve(
        channel === 'builder:layerExtents'
          ? {
              ok: true,
              extents: [
                { layerId: 'photos', ...box(0, 0) },
                { layerId: 'cloud', ...box(91_250, 0) },
              ],
              recentre: { blockers },
            }
          : {
              ok: true,
              manifest: { ...project.manifest, origin: [591_250, 3_200_000, 20] },
              backup: 'b',
            },
      ),
    );
    const reopen = vi.fn();
    return { call, reopen, project: () => project };
  };
  it('names the far layer and its distance, and re-centres on request', async () => {
    const d = deps();
    const s = createFarNotice(d);
    await s.getState().check('p', new Set(['cloud']));
    // 91,250 m to the box centre, 91,200 m to its near edge
    expect(s.getState().notice?.text).toContain('Cloud lies 91.2 km from the project origin');
    expect(s.getState().notice?.canRecentre).toBe(true);
    await s.getState().recentre();
    expect(d.call).toHaveBeenCalledWith('builder:recentre', {
      projectId: 'p',
      at: [591_250, 3_200_000],
    });
    expect(d.reopen).toHaveBeenCalled();
    expect(s.getState().notice?.text).toContain('Re-centred');
  });
  it('says why re-centring is not offered', async () => {
    const s = createFarNotice(deps(['2 issues']));
    await s.getState().check('p', new Set(['cloud']));
    expect(s.getState().notice?.canRecentre).toBe(false);
    expect(s.getState().notice?.text).toContain('not offered: this project holds 2 issues');
  });
  it('stays quiet when nothing is far', async () => {
    const s = createFarNotice(deps());
    await s.getState().check('p', new Set(['photos']));
    expect(s.getState().notice).toBeNull();
  });
});

describe('fresh layer ids', () => {
  it('a project just opened is its own baseline, then only new ids are fresh', () => {
    const a = freshLayerIds(null, { id: 'p', layerIds: ['a'] });
    expect([...a.fresh]).toEqual([]);
    const b = freshLayerIds(a.seen, { id: 'p', layerIds: ['a', 'b'] });
    expect([...b.fresh]).toEqual(['b']);
  });
  it('a project switch resets the baseline', () => {
    const a = freshLayerIds(null, { id: 'p', layerIds: ['a'] });
    const b = freshLayerIds(a.seen, { id: 'q', layerIds: ['a', 'x'] });
    expect([...b.fresh]).toEqual([]);
    expect(freshLayerIds(b.seen, null).seen).toBeNull();
  });
});

describe('notice lifecycle', () => {
  const origin: [number, number, number] = [500_000, 3_200_000, 20];
  const layers = [
    { id: 'cloud', name: 'Cloud' },
    { id: 'mesh', name: 'Mesh' },
    { id: 'photos', name: 'Photos' },
  ];
  const ex = (ids: string[]) =>
    ids.map((id) => ({
      layerId: id,
      ...(id === 'photos' ? box(0, 0) : id === 'cloud' ? box(30_000, 0) : box(30_020, 10, 5)),
    }));
  const make = (opts: { recentre?: unknown } = {}) => {
    let open = 'p';
    let extents = ex(['photos', 'cloud']);
    const call = vi.fn((channel: string) =>
      Promise.resolve(
        channel === 'builder:layerExtents'
          ? { ok: true, extents, recentre: { blockers: [] } }
          : (opts.recentre ?? { ok: true, manifest: { m: 1 }, backup: 'b' }),
      ),
    );
    const reopen = vi.fn();
    const store = createFarNotice({
      call,
      reopen,
      project: () => ({ id: open, manifest: { origin, layers } }),
    });
    return {
      store,
      call,
      reopen,
      switchTo: (id: string) => {
        open = id;
      },
      setExtents: (ids: string[]) => {
        extents = ex(ids);
      },
    };
  };
  it('a later nearby layer widens the notice instead of clearing it', async () => {
    const t = make();
    await t.store.getState().check('p', new Set(['cloud']));
    expect(t.store.getState().notice?.text).toContain('Cloud');
    t.setExtents(['photos', 'cloud', 'mesh']);
    await t.store.getState().check('p', new Set(['mesh']));
    const n = t.store.getState().notice;
    expect(n?.done).toBe(false);
    expect(n?.text).toContain('Cloud');
    expect(n?.text).toContain('Mesh');
    expect(n?.far.map((f) => f.layerId).sort()).toEqual(['cloud', 'mesh']);
    // an unrelated near layer keeps the notice as it is
    await t.store.getState().check('p', new Set(['photos']));
    expect(t.store.getState().notice?.far).toHaveLength(2);
  });
  it('only the latest of two concurrent checks applies', async () => {
    const t = make();
    const first = t.store.getState().check('p', new Set(['photos']));
    const second = t.store.getState().check('p', new Set(['cloud']));
    await Promise.all([first, second]);
    expect(t.store.getState().notice?.far.map((f) => f.layerId)).toEqual(['cloud']);
  });
  it('a result for a project that is no longer open is dropped', async () => {
    const t = make();
    const pending = t.store.getState().check('p', new Set(['cloud']));
    t.switchTo('q');
    await pending;
    expect(t.store.getState().notice).toBeNull();
  });
  it('re-centre on a notice of another project does nothing and clears it', async () => {
    const t = make();
    await t.store.getState().check('p', new Set(['cloud']));
    t.switchTo('q');
    await t.store.getState().recentre();
    expect(t.call).not.toHaveBeenCalledWith('builder:recentre', expect.anything());
    expect(t.reopen).not.toHaveBeenCalled();
    expect(t.store.getState().notice).toBeNull();
  });
  it('a refused re-centre says so and offers nothing more', async () => {
    const t = make({ recentre: { ok: false, error: 'the project holds issues' } });
    await t.store.getState().check('p', new Set(['cloud']));
    await t.store.getState().recentre();
    const n = t.store.getState().notice;
    expect(n?.text).toBe('Re-centring failed: the project holds issues');
    expect(n?.canRecentre).toBe(false);
    expect(t.reopen).not.toHaveBeenCalled();
  });
  it('a failed check from the palette shows an error, a silent one stays quiet', async () => {
    const store = createFarNotice({
      call: () => Promise.reject(new Error('offline')),
      reopen: vi.fn(),
      project: () => ({ id: 'p', manifest: { origin, layers } }),
    });
    await store.getState().check('p', new Set(['cloud']));
    expect(store.getState().notice).toBeNull();
    await store.getState().check('p', 'all');
    expect(store.getState().notice?.text).toContain('Could not check where layers lie: offline');
  });
});
