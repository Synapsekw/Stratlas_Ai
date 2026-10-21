import { describe, expect, it, vi } from 'vitest';
import type {
  HeightTiles,
  Layer,
  ProjectManifest,
  SitePoint,
  SurveyMeasurement,
} from '@aio/schema';
import { captureIndex } from '@aio/workspace';
import { planMoveToDate, type ModelPick, type MoveEnv, type Repicker } from './measureMove';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const raster = (id: string, capture: string, name = 'DSM'): Layer => ({
  kind: 'raster',
  id,
  name,
  visible: true,
  role: 'dsm',
  format: 'cog',
  src: { path: `rasters/${id}.tif` },
  capture,
});
const mesh = (id: string, capture: string, name = 'Model'): Layer => ({
  kind: 'mesh',
  id,
  name,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: I,
  capture,
});
const cloud = (id: string, capture: string): Layer => ({
  kind: 'pointcloud',
  id,
  name: 'Cloud',
  visible: true,
  src: { path: `clouds/${id}.copc.laz` },
  format: 'copc',
  capture,
});

function manifestOf(layers: Layer[], junEastM = 0): ProjectManifest {
  return {
    schema: 'aio.project/1',
    id: 'p1',
    name: 'Dated',
    crs: { epsg: 32640 },
    origin: [0, 0, 0],
    captures: [
      { id: 'jan', label: 'January', date: '2026-01-01' },
      {
        id: 'jun',
        label: 'June',
        date: '2026-06-01',
        ...(junEastM
          ? { lineUp: { eastM: junEastM, northM: 0, with: 'jan', at: '2026-10-16T08:00:00Z' } }
          : {}),
      },
    ],
    layers,
    severityModels: [],
    classCatalogues: [],
  };
}

const surface = (id: string, capture: string) =>
  ({ id, capture, source: { kind: 'dsm' } }) as unknown as HeightTiles;
const SURFACES = [surface('s-jan', 'jan'), surface('s-jun', 'jun')];

const pts: SitePoint[] = [
  [0, 0, 1],
  [10, 0, 2],
  [10, 10, 3],
];
function m(id: string, over: Partial<SurveyMeasurement> = {}): SurveyMeasurement {
  return {
    id,
    family: 'polygon',
    tool: 'area',
    label: `Area ${id}`,
    scope: { kind: 'survey', capture: 'jan' },
    points: pts,
    items: [],
    results: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** A fake re-picker: model Z 100 + index, ground Z 50 + index (overridable). */
function fakeRepick(over: Partial<Repicker> = {}) {
  const model = vi.fn((_layer: string, drawn: readonly SitePoint[]): Promise<ModelPick> =>
    Promise.resolve({ ok: true, z: Float64Array.from(drawn, (_p, i) => 100 + i) }),
  );
  const ground = vi.fn((_capture: string, drawn: readonly SitePoint[]): Promise<Float64Array> =>
    Promise.resolve(Float64Array.from(drawn, (_p, i) => 50 + i)),
  );
  return {
    model: over.model ? vi.fn(over.model) : model,
    ground: over.ground ? vi.fn(over.ground) : ground,
  };
}

function envOf(
  layers: Layer[],
  repick: Repicker,
  opts: { folders?: string[]; surfaces?: HeightTiles[]; junEastM?: number } = {},
): MoveEnv {
  const manifest = manifestOf(layers, opts.junEastM ?? 0);
  return {
    manifest,
    index: captureIndex(manifest),
    surfaces: opts.surfaces ?? SURFACES,
    repick,
    folders: new Set(opts.folders ?? []),
  };
}

const LAYERS = [
  raster('dsm-jan', 'jan'),
  raster('dsm-jun', 'jun'),
  mesh('model-jan', 'jan'),
  mesh('model-jun', 'jun'),
];

describe('planMoveToDate', () => {
  it('re-picks model vertices on the counterpart and ground vertices on the target ground', async () => {
    const repick = fakeRepick();
    const plan = await planMoveToDate(
      [m('a', { source: { layer: 'model-jan' }, pickedOn: ['model', 'ground', 'model'] })],
      'jun',
      envOf(LAYERS, repick),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(repick.model).toHaveBeenCalledTimes(1);
    expect(repick.model.mock.calls[0]?.[0]).toBe('model-jun');
    expect(repick.model.mock.calls[0]?.[1]).toEqual([pts[0], pts[2]]);
    expect(repick.ground.mock.calls[0]?.[0]).toBe('jun');
    expect(repick.ground.mock.calls[0]?.[1]).toEqual([pts[1]]);
    const moved = plan.next[0];
    expect(moved?.scope).toEqual({ kind: 'survey', capture: 'jun' });
    expect(moved?.source).toEqual({ layer: 'model-jun' });
    expect(moved?.points.map((p) => p[2])).toEqual([100, 50, 101]);
    expect(moved?.pickedOn).toEqual(['model', 'ground', 'model']);
  });

  it('takes the counterpart by slot, then by kind, and refuses without one', async () => {
    // by slot: same kind and name
    let repick = fakeRepick();
    await planMoveToDate(
      [m('a', { source: { layer: 'model-jan' } })],
      'jun',
      envOf(LAYERS, repick),
    );
    expect(repick.model.mock.calls[0]?.[0]).toBe('model-jun');
    // by kind: the one mesh of June has another name
    repick = fakeRepick();
    const loose = [raster('dsm-jan', 'jan'), mesh('model-jan', 'jan'), mesh('hull', 'jun', 'Hull')];
    const plan = await planMoveToDate(
      [m('a', { source: { layer: 'model-jan' } })],
      'jun',
      envOf(loose, repick),
    );
    expect(plan.ok).toBe(true);
    expect(repick.model.mock.calls[0]?.[0]).toBe('hull');
    // none: June has no cloud
    repick = fakeRepick();
    const none = await planMoveToDate(
      [m('a', { source: { layer: 'cloud-jan' } })],
      'jun',
      envOf([...LAYERS, cloud('cloud-jan', 'jan')], repick),
    );
    expect(none).toEqual({ ok: false, refusal: { kind: 'no-match', id: 'a', layer: 'cloud-jan' } });
    expect(repick.model).not.toHaveBeenCalled();
  });

  it('a measurement with no source takes the base layer of its own date, picked on the ground', async () => {
    const repick = fakeRepick();
    const plan = await planMoveToDate([m('a')], 'jun', envOf(LAYERS, repick));
    expect(plan.ok && plan.next[0]?.source).toEqual({ layer: 'dsm-jun' });
    expect(repick.model).not.toHaveBeenCalled();
    expect(repick.ground).toHaveBeenCalledTimes(1);
  });

  it('keeps the folder when the target has that name, else clears it', async () => {
    const repick = fakeRepick();
    const plan = await planMoveToDate(
      [m('a', { folder: 'Stockpiles' }), m('b', { folder: 'Roads' })],
      'jun',
      envOf(LAYERS, repick, { folders: ['Stockpiles'] }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.next[0]?.folder).toBe('Stockpiles');
    expect(plan.next[1]).not.toHaveProperty('folder');
  });

  it('refuses antenna measurements', async () => {
    const repick = fakeRepick();
    const plan = await planMoveToDate(
      [m('a'), m('t', { tool: 'antenna-tilt', family: 'line' })],
      'jun',
      envOf(LAYERS, repick),
    );
    expect(plan).toEqual({ ok: false, refusal: { kind: 'telecom' } });
    expect(repick.ground).not.toHaveBeenCalled();
  });

  it('refuses an unprepared target before re-picking', async () => {
    const repick = fakeRepick();
    const plan = await planMoveToDate(
      [m('a')],
      'jun',
      envOf(LAYERS, repick, { surfaces: [surface('s-jan', 'jan')] }),
    );
    expect(plan).toEqual({ ok: false, refusal: { kind: 'unprepared', capture: 'jun' } });
    expect(repick.ground).not.toHaveBeenCalled();
    expect(repick.model).not.toHaveBeenCalled();
  });

  it('refuses when a vertex has no data', async () => {
    const repick = fakeRepick({
      ground: (_c, drawn) => Promise.resolve(Float64Array.from(drawn, (_p, i) => (i ? NaN : 1))),
    });
    const plan = await planMoveToDate([m('a')], 'jun', envOf(LAYERS, repick));
    expect(plan).toEqual({ ok: false, refusal: { kind: 'no-data', id: 'a' } });
  });

  it('refuses when the model layer cannot be loaded', async () => {
    const repick = fakeRepick({
      model: () => Promise.resolve({ ok: false, why: 'not-loaded' } as const),
    });
    const plan = await planMoveToDate(
      [m('a', { source: { layer: 'model-jan' } })],
      'jun',
      envOf(LAYERS, repick),
    );
    expect(plan).toEqual({ ok: false, refusal: { kind: 'not-loaded', layer: 'model-jun' } });
  });

  it('maps need-3d and hidden-layer picks to their refusals', async () => {
    for (const why of ['need-3d', 'hidden-layer'] as const) {
      const repick = fakeRepick({ model: () => Promise.resolve({ ok: false, why } as const) });
      const plan = await planMoveToDate(
        [m('a', { source: { layer: 'model-jan' } })],
        'jun',
        envOf(LAYERS, repick),
      );
      expect(plan).toEqual({
        ok: false,
        refusal:
          why === 'need-3d' ? { kind: 'need-3d' } : { kind: 'hidden-layer', layer: 'model-jun' },
      });
    }
  });

  it('marks results stale and rewrites an old-date surface ref', async () => {
    const repick = fakeRepick();
    const item = {
      id: 'i1',
      from: { kind: 'survey', surface: 's-jan' },
      to: { kind: 'design', design: 'd1', layer: 'l1' },
      useDeadband: false,
    };
    const other = { id: 'i2', from: { kind: 'survey', surface: 's-mar' }, to: { kind: 'current' } };
    const result = {
      item: 'i1',
      status: 'ok',
      cutM3: 1,
      fillM3: 2,
      netM3: 1,
      totalM3: 3,
      areaM2: 4,
      areaCutM2: 1,
      areaFillM2: 1,
      areaUnchangedM2: 2,
      uncoveredM2: 0,
      fromLabel: 'a',
      toLabel: 'b',
      deadbandM: 0,
      usedDeadband: false,
    };
    const plan = await planMoveToDate(
      [
        m('a', {
          items: [item, other],
          results: [result],
        } as unknown as Partial<SurveyMeasurement>),
      ],
      'jun',
      envOf(LAYERS, repick, {
        surfaces: [...SURFACES, surface('s-mar', 'mar')],
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const moved = plan.next[0];
    expect(moved?.results.map((r) => r.status)).toEqual(['stale']);
    expect(moved?.items[0]?.from).toEqual({ kind: 'survey', surface: 's-jun' });
    expect(moved?.items[0]?.to).toEqual({ kind: 'design', design: 'd1', layer: 'l1' });
    expect(moved?.items[1]?.from).toEqual({ kind: 'survey', surface: 's-mar' });
  });

  it('refuses a comparison that would compare the target surface with itself', async () => {
    const repick = fakeRepick();
    const item = {
      id: 'i1',
      from: { kind: 'survey', surface: 's-jan' },
      to: { kind: 'survey', surface: 's-jun' },
      useDeadband: false,
    };
    const plan = await planMoveToDate(
      [m('a', { items: [item] } as unknown as Partial<SurveyMeasurement>)],
      'jun',
      envOf(LAYERS, repick),
    );
    expect(plan).toEqual({ ok: false, refusal: { kind: 'same-surface', id: 'a' } });
  });

  it('stores points in the target line-up frame', async () => {
    const repick = fakeRepick();
    // June lined up 2 m east: a point drawn at E 10 is stored at E 8
    const plan = await planMoveToDate([m('a')], 'jun', envOf(LAYERS, repick, { junEastM: 2 }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.next[0]?.points.map((p) => p[0])).toEqual([-2, 8, 8]);
    expect(plan.next[0]?.points.map((p) => p[1])).toEqual([0, 0, 10]);
    // re-picked where drawn
    expect(repick.ground.mock.calls[0]?.[1]).toEqual(pts);
  });

  it('files a Needs a date measurement without a re-pick', async () => {
    const repick = fakeRepick();
    const plan = await planMoveToDate(
      [m('a', { scope: { kind: 'site' }, pickedOn: ['ground', 'ground', 'ground'] })],
      'jun',
      envOf(LAYERS, repick, { junEastM: 2, surfaces: [] }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const filed = plan.next[0];
    expect(filed?.scope).toEqual({ kind: 'survey', capture: 'jun' });
    expect(filed?.source).toEqual({ layer: 'dsm-jun' });
    // ground picks fit any source of the date: kept
    expect(filed?.pickedOn).toEqual(['ground', 'ground', 'ground']);
    // stays where drawn: the June shift taken off, heights as they were
    expect(filed?.points).toEqual([
      [-2, 0, 1],
      [8, 0, 2],
      [8, 10, 3],
    ]);
    expect(repick.ground).not.toHaveBeenCalled();
    expect(repick.model).not.toHaveBeenCalled();
  });

  it('keeps the source and picks of a Needs a date measurement on a layer of the target', async () => {
    const plan = await planMoveToDate(
      [
        m('a', {
          scope: { kind: 'site' },
          source: { layer: 'model-jun' },
          pickedOn: ['model', 'ground', 'model'],
        }),
      ],
      'jun',
      envOf(LAYERS, fakeRepick()),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.next[0]?.source).toEqual({ layer: 'model-jun' });
    expect(plan.next[0]?.pickedOn).toEqual(['model', 'ground', 'model']);
  });

  it("files on the target's base layer when the source is of another date", async () => {
    const plan = await planMoveToDate(
      [
        m('a', {
          scope: { kind: 'site' },
          source: { layer: 'model-jan' },
          pickedOn: ['model', 'ground', 'model'],
        }),
        m('b', { scope: { kind: 'site' }, source: { layer: 'model-jun' }, pickedOn: ['model'] }),
      ],
      'jun',
      envOf(LAYERS, fakeRepick()),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // model picks of another date's model do not fit the target's DSM: dropped
    expect(plan.next[0]?.source).toEqual({ layer: 'dsm-jun' });
    expect(plan.next[0]).not.toHaveProperty('pickedOn');
    // picks the wrong length are dropped, the source of the target kept
    expect(plan.next[1]?.source).toEqual({ layer: 'model-jun' });
    expect(plan.next[1]).not.toHaveProperty('pickedOn');
  });

  it('leaves out a measurement already on the target', async () => {
    const repick = fakeRepick();
    const plan = await planMoveToDate(
      [m('a', { scope: { kind: 'survey', capture: 'jun' } }), m('b')],
      'jun',
      envOf(LAYERS, repick),
    );
    expect(plan.ok && plan.next.map((x) => x.id)).toEqual(['b']);
  });

  it('files a measurement whose date was deleted like a Needs a date one', async () => {
    const repick = fakeRepick();
    const plan = await planMoveToDate(
      [m('a', { scope: { kind: 'survey', capture: 'gone' } })],
      'jun',
      envOf(LAYERS, repick),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.next[0]?.scope).toEqual({ kind: 'survey', capture: 'jun' });
    expect(plan.next[0]?.source).toEqual({ layer: 'dsm-jun' });
    expect(repick.ground).not.toHaveBeenCalled();
  });

  it('is all or nothing: one refusal moves none', async () => {
    const repick = fakeRepick();
    const plan = await planMoveToDate(
      [m('a'), m('b', { source: { layer: 'cloud-jan' } })],
      'jun',
      envOf([...LAYERS, cloud('cloud-jan', 'jan')], repick),
    );
    expect(plan.ok).toBe(false);
    expect(plan).not.toHaveProperty('next');
  });
});
