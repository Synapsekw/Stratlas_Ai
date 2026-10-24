import { describe, expect, it, vi } from 'vitest';
import {
  createFarNotice,
  farLayers,
  freshLayerIds,
  photosOffSurvey,
  planGap,
  recentreTarget,
} from './farContent';

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

describe('handheld camera GPS', () => {
  const origin: [number, number, number] = [500_000, 3_200_000, 20];
  const layers = [
    { kind: 'pointcloud', id: 'cloud', name: 'Cloud' },
    { kind: 'photos', id: 'photos', name: 'Photos' },
  ];
  type Ex = { layerId: string; min: readonly number[]; max: readonly number[] }[];
  /** Task 8's deps with the extents answers given in turn (the last one repeats). */
  const depsWith = (...answers: Ex[]) => {
    let n = 0;
    const call = vi.fn((channel: string): Promise<unknown> => {
      if (channel === 'builder:layerExtents') {
        const extents = answers[Math.min(n, answers.length - 1)] ?? [];
        n += 1;
        return Promise.resolve({ ok: true, extents, recentre: { blockers: [] } });
      }
      return Promise.resolve({ ok: true, manifest: { origin, layers }, backup: 'b' });
    });
    const reopen = vi.fn();
    return { call, reopen, project: () => ({ id: 'p', manifest: { origin, layers } }) };
  };
  const photosFar: Ex = [
    { layerId: 'cloud', ...box(0, 0) },
    { layerId: 'photos', ...box(91_000, 0) },
  ];
  const cloudFar: Ex = [
    { layerId: 'photos', ...box(0, 0) },
    { layerId: 'cloud', ...box(91_000, 0) },
  ];

  it('a far photos layer beside survey data offers to ignore its GPS, not to re-centre', async () => {
    // cloud near the origin (older), photos 91 km away (fresh)
    const d = depsWith(photosFar);
    const s = createFarNotice(d);
    await s.getState().check('p', new Set(['photos']));
    expect(s.getState().notice?.canRecentre).toBe(false);
    expect(s.getState().notice?.photoLayers).toEqual(['photos']);
    expect(s.getState().notice?.text).toContain("a camera's GPS can be kilometres out");
    expect(s.getState().notice?.text).toContain('keep them in Inspect without a place');
    await s.getState().ignorePhotoGps();
    expect(d.call).toHaveBeenCalledWith('builder:updateLayers', {
      projectId: 'p',
      layerIds: ['photos'],
      patch: { photoPositions: 'clear' },
    });
    expect(d.reopen).toHaveBeenCalled();
    expect(s.getState().notice?.done).toBe(true);
    expect(s.getState().notice?.text).toContain('they stay in Inspect');
  });

  it('a far survey layer when only photos placed the origin says survey data is better', async () => {
    const s = createFarNotice(depsWith(cloudFar));
    await s.getState().check('p', new Set(['cloud']));
    const n = s.getState().notice;
    expect(n?.canRecentre).toBe(true);
    expect(n?.photoLayers).toEqual([]);
    expect(n?.text).toContain('Only photos placed this project so far');
  });

  it('after a re-centre on survey data, photos left far away are offered the same', async () => {
    // photos near the old origin, cloud fresh and far; re-centre; the second extents answer has
    // the photos 91 km from the new origin
    const d = depsWith(cloudFar, [
      { layerId: 'photos', ...box(-91_000, 0) },
      { layerId: 'cloud', ...box(0, 0) },
    ]);
    const s = createFarNotice(d);
    await s.getState().check('p', new Set(['cloud']));
    await s.getState().recentre();
    expect(d.reopen).toHaveBeenCalled();
    const n = s.getState().notice;
    expect(n?.photoLayers).toEqual(['photos']);
    expect(n?.done).toBe(false);
    expect(n?.canRecentre).toBe(false);
    expect(n?.text).toContain('Re-centred');
    expect(n?.text).toContain("a camera's GPS can be kilometres out");
  });

  it('a re-centre that leaves no photos far ends as before', async () => {
    const d = depsWith(cloudFar, [
      { layerId: 'photos', ...box(10, 0) },
      { layerId: 'cloud', ...box(0, 0) },
    ]);
    const s = createFarNotice(d);
    await s.getState().check('p', new Set(['cloud']));
    await s.getState().recentre();
    expect(s.getState().notice?.done).toBe(true);
    expect(s.getState().notice?.photoLayers).toEqual([]);
  });

  describe('a model and handheld photos in one import', () => {
    const withMesh = [
      { kind: 'mesh', id: 'mesh', name: 'Model' },
      { kind: 'photos', id: 'photos', name: 'Photos' },
    ];
    const both = (extents: Ex) => {
      const call = vi.fn((channel: string): Promise<unknown> =>
        Promise.resolve(
          channel === 'builder:layerExtents'
            ? { ok: true, extents, recentre: { blockers: [] } }
            : { ok: true, manifest: { origin, layers: withMesh }, backup: 'b' },
        ),
      );
      return {
        call,
        reopen: vi.fn(),
        project: () => ({ id: 'p', manifest: { origin, layers: withMesh } }),
      };
    };

    it('the model near the origin keeps it: the far photos are offered to ignore their GPS', async () => {
      const s = createFarNotice(
        both([
          { layerId: 'mesh', ...box(0, 0) },
          { layerId: 'photos', ...box(40_000, 0) },
        ]),
      );
      await s.getState().check('p', new Set(['mesh', 'photos']));
      const n = s.getState().notice;
      expect(n?.canRecentre).toBe(false);
      expect(n?.photoLayers).toEqual(['photos']);
      expect(n?.text).toContain("a camera's GPS can be kilometres out");
    });

    it('a far model and far photos at another place re-centre on the model', async () => {
      const s = createFarNotice(
        both([
          { layerId: 'mesh', ...box(30_000, 0) },
          { layerId: 'photos', ...box(70_000, 20_000) },
        ]),
      );
      await s.getState().check('p', new Set(['mesh', 'photos']));
      const n = s.getState().notice;
      expect(n?.canRecentre).toBe(true);
      expect(n?.target).toEqual([530_000, 3_200_000]);
    });
  });

  it('a photo a few hundred metres from the survey is offered an align, in metres', async () => {
    const d = depsWith([
      { layerId: 'cloud', ...box(0, 0) },
      { layerId: 'photos', ...box(300, 0) },
    ]);
    const s = createFarNotice(d);
    await s.getState().check('p', new Set());
    const n = s.getState().notice;
    expect(n?.canRecentre).toBe(false);
    expect(n?.far).toEqual([]);
    expect(n?.photoLayers).toEqual(['photos']);
    expect(n?.text).toContain('Photos is 200 m from the survey.');
    expect(n?.text).toContain('Align the photos onto the project');
    expect(
      photosOffSurvey(
        [
          { layerId: 'cloud', ...box(0, 0) },
          { layerId: 'photos', ...box(150, 0) },
        ],
        (id) => id === 'photos',
      ),
    ).toEqual([]);
  });

  it('a photo on the origin is quiet when the survey is the layer that is far', async () => {
    const s = createFarNotice(
      depsWith([
        { layerId: 'photos', ...box(0, 0) },
        { layerId: 'cloud', ...box(91_250, 0) },
      ]),
    );
    await s.getState().check('p', new Set());
    expect(s.getState().notice).toBeNull();
  });

  it('a failed clear says so and keeps the photos', async () => {
    const d = depsWith(photosFar);
    d.call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:layerExtents'
          ? { ok: true, extents: photosFar, recentre: { blockers: [] } }
          : { ok: false, error: 'disk full' },
      ),
    );
    const s = createFarNotice(d);
    await s.getState().check('p', new Set(['photos']));
    await s.getState().ignorePhotoGps();
    expect(s.getState().notice?.text).toBe('Clearing the GPS places failed: disk full');
    expect(s.getState().notice?.photoLayers).toEqual([]);
    expect(d.reopen).not.toHaveBeenCalled();
  });
});
