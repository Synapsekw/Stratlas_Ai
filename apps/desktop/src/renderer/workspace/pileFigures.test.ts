import {
  defaultSurveySettings,
  type ComparisonResult,
  type SurveyMeasurement,
  type SurveySettings,
} from '@aio/schema';
import { createVolumetricStore, type VolumetricDeps } from '@aio/volumetric';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { connectPileFigures, pileFigures } from './pileFigures';

const CAPTURES = [
  { epoch: 'e1', captureId: 'c1', date: '2026-01-12', label: '12 Jan 2026' },
  { epoch: 'e2', captureId: 'c2', date: '2026-02-09', label: '9 Feb 2026' },
];

const result = (net: number, capture: string | undefined, carried = false): ComparisonResult => ({
  item: 'i1',
  status: 'ok',
  cutM3: 0,
  fillM3: net,
  netM3: net,
  totalM3: net,
  areaM2: 100,
  areaCutM2: 0,
  areaFillM2: 0,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'Triangulated toe',
  toLabel: capture ?? 'Current survey',
  ...(capture ? { toCapture: capture } : {}),
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.1,
  engine: 'ts',
  fingerprint: carried ? `kit:P01:${capture ?? ''}:tin` : 'engine',
  computedAt: '2026-10-20T00:00:00.000Z',
  ...(carried ? { carried: { from: 'kit', base: 'tin', pile: 'P01', epoch: 'e2' } } : {}),
});

/** A kit pile converted to a volume measurement, with its carried figures. */
function pile(over: Partial<SurveyMeasurement> = {}): SurveyMeasurement {
  return {
    id: 'm-p01',
    family: 'polygon',
    tool: 'volume',
    label: 'Pile 01',
    scope: { kind: 'site' },
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ],
    material: 'sand',
    items: [{ id: 'i1', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    results: [result(1200, 'c2', true)],
    series: [result(800, 'c1', true), result(1200, 'c2', true)],
    origin: { kind: 'kit-pile', pile: 'P01' },
    createdAt: '2026-10-20T00:00:00.000Z',
    ...over,
  };
}

const settings: SurveySettings = {
  ...defaultSurveySettings(),
  materials: [{ id: 'sand', name: 'Sand', densityTPerM3: 1.5 }],
};

const figures = (ms: SurveyMeasurement[]) => pileFigures({ captures: CAPTURES }, ms, settings, []);

describe('pile figures from the volume measurements', () => {
  it("reads each date's figure with the material's tonnage", () => {
    const f = figures([pile()]);
    expect(f.P01?.e2?.value).toMatch(/^1\D?200/);
    expect(f.P01?.e2?.tonnes).toMatch(/^1\D?800/);
    expect(f.P01?.e1?.value).toMatch(/800/);
  });

  it('shows the new figure after Recompute replaces the carried one', () => {
    const recomputed = pile({ results: [result(1350, 'c2')], series: [result(1350, 'c2')] });
    const f = figures([recomputed]);
    expect(f.P01?.e2?.value).toMatch(/^1\D?350/);
    // the earlier date has no result any more: the name only
    expect(f.P01?.e1).toBeUndefined();
  });

  it("shows the outline edit's figure once the edited pile is computed", () => {
    const edited = pile({
      points: [
        [0, 0, 0],
        [20, 0, 0],
        [20, 10, 0],
      ],
      results: [result(2400, 'c2')],
      series: [],
    });
    expect(figures([edited]).P01?.e2?.value).toMatch(/^2\D?400/);
  });

  it('lists a pile of a new build that is not computed yet with no figure', () => {
    const f = figures([pile({ results: [], series: [] })]);
    expect(f).toEqual({ P01: {} });
  });

  it('marks a stale figure as the card does, by the same predicate', () => {
    const ms = [pile({ results: [result(1350, 'c2')], series: [result(900, 'c1')] })];
    const stale = pileFigures({ captures: CAPTURES }, ms, settings, [], {
      isStale: (_m, r, stored) => stored && r.netM3 === 1350,
    });
    expect(stale.P01?.e2?.value).toMatch(/^1\D?350.*, stale$/);
    expect(stale.P01?.e1?.value).not.toMatch(/stale/);
    // a row the store marks stale is stale without a predicate
    const marked = pile({ results: [{ ...result(1350, 'c2'), status: 'stale' }], series: [] });
    expect(figures([marked]).P01?.e2?.value).toMatch(/, stale$/);
  });

  it('shows a result that names no date on the latest date only', () => {
    const f = figures([pile({ results: [result(640, undefined)], series: [] })]);
    expect(f.P01?.e2?.value).toMatch(/640/);
    expect(f.P01?.e1).toBeUndefined();
  });

  it('a dated row wins the latest date over a result with no date', () => {
    const f = figures([pile({ results: [result(640, undefined)], series: [result(700, 'c2')] })]);
    expect(f.P01?.e2?.value).toMatch(/700/);
  });

  it('follows the pile a rebuild renumbered the measurement to', () => {
    const a = pile({ id: 'a', origin: { kind: 'kit-pile', pile: 'P02' } });
    const b = pile({
      id: 'b',
      results: [result(300, 'c2')],
      series: [],
      origin: { kind: 'kit-pile', pile: 'P01' },
    });
    const f = figures([a, b]);
    expect(f.P02?.e2?.value).toMatch(/^1\D?200/);
    expect(f.P01?.e2?.value).toMatch(/^300/);
  });

  it('leaves out measurements that are not kit piles', () => {
    const plain: SurveyMeasurement = { ...pile() };
    delete plain.origin;
    expect(figures([plain])).toEqual({});
  });

  it('keeps the volumetric store in step as the measurements change', async () => {
    const ws = createWorkspace();
    ws.getState().openProject({
      id: 'p',
      root: '/p',
      manifest: {
        schema: 'aio.project/1',
        id: 'p',
        name: 'P',
        crs: { epsg: 32639 },
        origin: [0, 0, 0],
        captures: [],
        layers: [],
        severityModels: [],
        classCatalogues: [],
      },
    });
    const deps: VolumetricDeps = {
      workspace: ws,
      readVolumes: () =>
        Promise.resolve({
          ok: true,
          volumes: {
            schema: 'aio.volumes/1',
            densityTPerM3: 1.6,
            deadbandM: 0.1,
            defaultBase: 'tin',
            bases: [],
            captures: CAPTURES,
            piles: [],
            totals: {},
            pileChange: { cut: 0, fill: 0, net: 0 },
            siteChange: { cut: 0, fill: 0, net: 0 },
          } as never,
          edits: null,
        }),
      startService: () =>
        ({ dispose: () => undefined }) as unknown as ReturnType<VolumetricDeps['startService']>,
    };
    const v = createVolumetricStore(deps);
    let ms = [pile({ results: [], series: [] })];
    const listeners = new Set<() => void>();
    const off = connectPileFigures(v, {
      measurements: () => ms,
      settings: () => settings,
      templates: () => [],
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    });
    await v.getState().load();
    expect(v.getState().pileFigures).toEqual({ P01: {} });
    ms = [pile()];
    for (const l of listeners) l();
    expect(v.getState().pileFigures.P01?.e2?.value).toMatch(/^1\D?200/);
    off();
  });
});
