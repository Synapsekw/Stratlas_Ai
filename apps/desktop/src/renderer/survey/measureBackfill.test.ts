import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HeightTiles,
  Layer,
  ProjectManifest,
  SitePoint,
  SurveyMeasurement,
} from '@aio/schema';
import { t } from '@aio/ui';
import { captureIndex, workspace } from '@aio/workspace';
import { compareStore } from './compareStore';
import { setDateSurfaceSource } from './dateSurfaces';
import {
  BACKFILL_MARGIN_M,
  BACKFILL_TOL_M,
  followBackfill,
  forgetBackfills,
  planBackfill,
  type BackfillEnv,
} from './measureBackfill';
import { measureStore, undoMeasureChange } from './measureStore';

const flags = vi.hoisted((): { annotateReadOnly: boolean } => ({ annotateReadOnly: false }));

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'Not configured' }) },
  jobs: { getState: () => ({}) },
}));
vi.mock('@aio/annotate', () => ({ isAnnotateReadOnly: () => flags.annotateReadOnly }));

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const raster = (id: string, capture: string, role: 'dsm' | 'ortho' = 'dsm'): Layer => ({
  kind: 'raster',
  id,
  name: role.toUpperCase(),
  visible: true,
  role,
  format: 'cog',
  src: { path: `rasters/${id}.tif` },
  capture,
});
const mesh = (id: string, capture: string): Layer => ({
  kind: 'mesh',
  id,
  name: 'Model',
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: I,
  capture,
});
const LAYERS: Layer[] = [
  raster('dsm-jan', 'jan'),
  raster('dsm-jun', 'jun'),
  raster('ortho-jun', 'jun', 'ortho'),
  mesh('model-jan', 'jan'),
];
const manifestOf = (captures = true): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p1',
  name: 'Dated',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: captures
    ? [
        { id: 'jan', label: 'January', date: '2026-01-01' },
        { id: 'jun', label: 'June', date: '2026-06-01' },
      ]
    : [],
  layers: captures ? LAYERS : [],
  severityModels: [],
  classCatalogues: [],
});
const surface = (id: string, capture: string, layer?: string) =>
  ({
    id,
    capture,
    source: layer ? { kind: 'dsm', layer } : { kind: 'pointcloud' },
  }) as unknown as HeightTiles;
const SURFACES = [surface('s-jan', 'jan', 'dsm-jan'), surface('s-jun', 'jun', 'dsm-jun')];

const pts: SitePoint[] = [
  [0, 0, 7],
  [10, 0, 7],
  [10, 10, 7],
];
function m(id: string, over: Partial<SurveyMeasurement> = {}): SurveyMeasurement {
  return {
    id,
    family: 'polygon',
    tool: 'area',
    label: `Area ${id}`,
    scope: { kind: 'site' },
    points: pts,
    items: [],
    results: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** A ground that answers a fixed height per date (per vertex when an array). */
function groundOf(h: Record<string, number | number[]>): BackfillEnv['ground'] {
  return (capture, drawn) =>
    Promise.resolve(
      Float64Array.from(drawn, (_p, i) => {
        const v = h[capture];
        return Array.isArray(v) ? (v[i] ?? Number.NaN) : (v ?? Number.NaN);
      }),
    );
}
function env(
  h: Record<string, number | number[]>,
  surfaces: readonly HeightTiles[] = SURFACES,
): BackfillEnv & { calls: string[] } {
  const manifest = manifestOf();
  const calls: string[] = [];
  const g = groundOf(h);
  return {
    manifest,
    index: captureIndex(manifest),
    surfaces,
    ground: (c, d) => {
      calls.push(c);
      return g(c, d);
    },
    calls,
  };
}

describe('planning the backfill', () => {
  it('uses the exact tolerances', () => {
    expect(BACKFILL_TOL_M).toBe(0.1);
    expect(BACKFILL_MARGIN_M).toBe(0.25);
  });

  it('files a measurement whose source layer has a date without sampling', async () => {
    const e = env({ jan: 0, jun: 0 });
    const out = await planBackfill(
      [
        m('a', { source: { layer: 'model-jan' } }),
        m('b', { scope: { kind: 'survey', capture: 'jun' } }),
      ],
      e,
    );
    expect(e.calls).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'a',
      scope: { kind: 'survey', capture: 'jan' },
      source: { layer: 'model-jan' },
      pickedOn: ['model', 'model', 'model'],
      points: pts,
    });
  });

  it('files only a clear height match', async () => {
    const out = await planBackfill([m('a')], env({ jan: 7 - 0.03, jun: 7 + 1.2 }));
    expect(out).toHaveLength(1);
    expect(out[0]?.scope).toEqual({ kind: 'survey', capture: 'jan' });
    expect(out[0]?.source).toEqual({ layer: 'dsm-jan' });
    expect(out[0]?.points).toEqual(pts);
  });

  it('takes the base layer when the matched surface is not a DSM', async () => {
    const surfaces = [surface('s-jan', 'jan', 'dsm-jan'), surface('s-jun', 'jun')];
    const out = await planBackfill([m('a')], env({ jan: 3, jun: 7.05 }, surfaces));
    expect(out[0]?.scope).toEqual({ kind: 'survey', capture: 'jun' });
    expect(out[0]?.source).toEqual({ layer: 'dsm-jun' });
  });

  it('leaves a measurement that matches two dates alike', async () => {
    expect(await planBackfill([m('a')], env({ jan: 7.02, jun: 7.1 }))).toEqual([]);
  });

  it('leaves a measurement off every date by more than the tolerance', async () => {
    expect(await planBackfill([m('a')], env({ jan: 6.5, jun: 8 }))).toEqual([]);
  });

  it('files on the only prepared date when it matches', async () => {
    const out = await planBackfill([m('a')], env({ jan: 7.05 }, SURFACES.slice(0, 1)));
    expect(out[0]?.scope).toEqual({ kind: 'survey', capture: 'jan' });
  });

  it('guesses ground and model per vertex', async () => {
    const out = await planBackfill(
      [m('a', { points: [...pts, [0, 10, 7]] })],
      env({ jan: [7, 7.02, 9, 7.01], jun: 2 }),
    );
    expect(out[0]?.pickedOn).toEqual(['ground', 'ground', 'model', 'ground']);
  });

  it('waits for prepared surfaces before height matching', async () => {
    const e = env({ jan: 7, jun: 2 }, []);
    expect(await planBackfill([m('a')], e)).toEqual([]);
    expect(e.calls).toEqual([]);
  });

  it('counts antenna measurements like any other', async () => {
    const out = await planBackfill(
      [m('a', { family: 'line', tool: 'azimuth' })],
      env({ jan: 7, jun: 2 }),
    );
    expect(out[0]?.scope).toEqual({ kind: 'survey', capture: 'jan' });
  });
});

// ---------------------------------------------------------------- the runner

function load(ms: SurveyMeasurement[], opts: { captures?: boolean; readOnly?: boolean } = {}) {
  const manifest = manifestOf(opts.captures ?? true);
  workspace.getState().openProject({ id: 'p1', root: 'E:/p', manifest });
  workspace.getState().setDates(captureIndex(manifest));
  const file = { schema: 'aio.measurements/1' as const, measurements: ms };
  measureStore.setState({
    projectId: 'p1',
    status: 'ready',
    readOnly: opts.readOnly ?? false,
    file,
    savedText: JSON.stringify(file),
    note: null,
    undoChange: null,
    autosave: false,
  });
}
const prepared = () => {
  compareStore.setState({ projectId: 'p1', status: 'ready', surfaces: SURFACES });
};
const scopes = () => measureStore.getState().file.measurements.map((x) => x.scope);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  flags.annotateReadOnly = false;
  forgetBackfills();
  compareStore.setState({ projectId: null, status: 'idle', surfaces: [] });
  // January's ground matches the stored heights, June's does not
  setDateSurfaceSource((capture) =>
    Promise.resolve((es: Float64Array) =>
      Promise.resolve(Float64Array.from(es, () => (capture === 'jan' ? 7.02 : 3))),
    ),
  );
});
afterEach(() => {
  setDateSurfaceSource(null);
  measureStore.setState({ note: null, undoChange: null });
  workspace.setState({ project: null, dates: null });
});

describe('the backfill on a project', () => {
  it('runs once with one note and Undo; Undo puts them back and it does not run again', async () => {
    load([m('a'), m('b'), m('c', { scope: { kind: 'survey', capture: 'jun' } })]);
    prepared();
    const notes: unknown[] = [];
    const offNotes = measureStore.subscribe((s, prev) => {
      if (s.note !== prev.note && s.note) notes.push(s.note);
    });
    const off = followBackfill();
    await settle();
    expect(scopes()).toEqual([
      { kind: 'survey', capture: 'jan' },
      { kind: 'survey', capture: 'jan' },
      { kind: 'survey', capture: 'jun' },
    ]);
    expect(notes).toHaveLength(1);
    const note = measureStore.getState().note;
    expect(note).toMatchObject({
      text: t('tree.measure.backfill.done', { count: 2 }),
      danger: false,
      undo: true,
    });
    // an ordinary edit that waits for Save
    expect(measureStore.getState().savedText).not.toBe(
      JSON.stringify(measureStore.getState().file),
    );
    expect(undoMeasureChange(note?.seq ?? -1)).toBe(true);
    expect(scopes().slice(0, 2)).toEqual([{ kind: 'site' }, { kind: 'site' }]);
    // a surfaces refresh in the same session does not run it again
    compareStore.setState({ surfaces: [...SURFACES] });
    await settle();
    expect(scopes().slice(0, 2)).toEqual([{ kind: 'site' }, { kind: 'site' }]);
    expect(notes).toHaveLength(1);
    off();
    offNotes();
  });

  it('posts no note when nothing is filed', async () => {
    setDateSurfaceSource(() =>
      Promise.resolve((es: Float64Array) => Promise.resolve(Float64Array.from(es, () => 0))),
    );
    load([m('a')]);
    prepared();
    const off = followBackfill();
    await settle();
    expect(scopes()).toEqual([{ kind: 'site' }]);
    expect(measureStore.getState().note).toBeNull();
    off();
  });

  it('does not run read-only, for a look-only reviewer, or without dates', async () => {
    for (const setup of [
      () => {
        load([m('a')], { readOnly: true });
      },
      () => {
        load([m('a')]);
        flags.annotateReadOnly = true;
      },
      () => {
        load([m('a')], { captures: false });
      },
    ]) {
      forgetBackfills();
      flags.annotateReadOnly = false;
      setup();
      prepared();
      const off = followBackfill();
      await settle();
      expect(scopes()).toEqual([{ kind: 'site' }]);
      expect(measureStore.getState().note).toBeNull();
      off();
    }
  });

  it('waits for the prepared surfaces to load before it runs', async () => {
    load([m('a')]);
    const off = followBackfill();
    await settle();
    expect(scopes()).toEqual([{ kind: 'site' }]);
    prepared();
    await settle();
    expect(scopes()).toEqual([{ kind: 'survey', capture: 'jan' }]);
    off();
  });

  it('drops a plan when the measurements changed while the heights were read', async () => {
    const held: (() => void)[] = [];
    setDateSurfaceSource(
      () =>
        new Promise((r) => {
          held.push(() => {
            r((es: Float64Array) => Promise.resolve(Float64Array.from(es, () => 7)));
          });
        }),
    );
    load([m('a')]);
    prepared();
    const off = followBackfill();
    const file = measureStore.getState().file;
    measureStore.setState({
      file: { ...file, measurements: file.measurements.map((x) => ({ ...x, label: 'Renamed' })) },
    });
    expect(held.length).toBeGreaterThan(0);
    for (const h of held) h();
    await settle();
    await settle();
    expect(measureStore.getState().note).toBeNull();
    expect(scopes()).toEqual([{ kind: 'site' }]);
    off();
  });
});
