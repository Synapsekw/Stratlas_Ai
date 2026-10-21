import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HeightTiles,
  Layer,
  ProjectManifest,
  SitePoint,
  SurveyMeasurement,
} from '@aio/schema';
import { formatDate, t } from '@aio/ui';
import { captureIndex, workspace } from '@aio/workspace';
import { Group, Mesh, Scene, Vector3 } from 'three';
import { compareStore, computeAll } from './compareStore';
import { setDateSurfaceSource } from './dateSurfaces';
import type { Repicker } from './measureMove';
import {
  copyMeasurementToDate,
  followLayerDates,
  moveMeasurementsToDate,
  setMoveRepicker,
} from './measureMoveRun';
import { measureStore, undoMeasureChange } from './measureStore';

const flags = vi.hoisted((): { annotateReadOnly: boolean; scene: unknown } => ({
  annotateReadOnly: false,
  scene: null,
}));

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'Not configured' }) },
  jobs: { getState: () => ({}) },
}));
vi.mock('@aio/annotate', () => ({ isAnnotateReadOnly: () => flags.annotateReadOnly }));
vi.mock('@aio/engine', () => ({ getActiveScene: () => flags.scene }));
vi.mock('./compareStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeAll: vi.fn(() => Promise.resolve()),
}));

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const raster = (id: string, capture: string): Layer => ({
  kind: 'raster',
  id,
  name: 'DSM',
  visible: true,
  role: 'dsm',
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
const cloud = (id: string, capture: string): Layer => ({
  kind: 'pointcloud',
  id,
  name: 'Cloud',
  visible: true,
  src: { path: `clouds/${id}.copc.laz` },
  format: 'copc',
  capture,
});
const LAYERS: Layer[] = [
  raster('dsm-jan', 'jan'),
  raster('dsm-jun', 'jun'),
  mesh('model-jan', 'jan'),
  mesh('model-jun', 'jun'),
  cloud('cloud-jan', 'jan'),
  cloud('cloud-jun', 'jun'),
];
const manifestOf = (layers: Layer[] = LAYERS): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p1',
  name: 'Dated',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'jan', label: 'January', date: '2026-01-01' },
    { id: 'jun', label: 'June', date: '2026-06-01' },
  ],
  layers,
  severityModels: [],
  classCatalogues: [],
});
const surface = (id: string, capture: string) =>
  ({ id, capture, source: { kind: 'dsm' } }) as unknown as HeightTiles;
const SURFACES = [surface('s-jan', 'jan'), surface('s-jun', 'jun')];

const pts: SitePoint[] = [
  [0, 0, 1],
  [10, 0, 2],
  [10, 10, 3],
];
const result = {
  item: 'i1',
  status: 'ok' as const,
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
function m(id: string, over: Partial<SurveyMeasurement> = {}): SurveyMeasurement {
  return {
    id,
    family: 'polygon',
    tool: 'area',
    label: `Area ${id}`,
    scope: { kind: 'survey', capture: 'jan' },
    source: { layer: 'dsm-jan' },
    pickedOn: ['ground', 'ground', 'ground'],
    points: pts,
    items: [],
    results: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

function load(ms: SurveyMeasurement[], layers?: Layer[]) {
  const manifest = manifestOf(layers);
  workspace.getState().openProject({ id: 'p1', root: 'E:/p', manifest });
  workspace.getState().setDates(captureIndex(manifest));
  const file = { schema: 'aio.measurements/1' as const, measurements: ms };
  measureStore.setState({
    projectId: 'p1',
    status: 'ready',
    readOnly: false,
    file,
    savedText: JSON.stringify(file),
    note: null,
    undoChange: null,
    autosave: false,
  });
}

const fake: Repicker = {
  model: (_l, drawn) =>
    Promise.resolve({ ok: true, z: Float64Array.from(drawn, (_p, i) => 100 + i) }),
  ground: (_c, drawn) => Promise.resolve(Float64Array.from(drawn, (_p, i) => 50 + i)),
};
const file = () => measureStore.getState().file.measurements;
const byId = (id: string) => file().find((x) => x.id === id);

beforeEach(() => {
  flags.annotateReadOnly = false;
  flags.scene = null;
  vi.mocked(computeAll).mockClear();
  compareStore.setState({ surfaces: SURFACES });
  setMoveRepicker(fake);
  // the prepared ground answers 7 everywhere
  setDateSurfaceSource(() =>
    Promise.resolve((es: Float64Array) => Promise.resolve(Float64Array.from(es, () => 7))),
  );
});
afterEach(() => {
  setMoveRepicker(null);
  setDateSurfaceSource(null);
  workspace.setState({ project: null, dates: null });
});

describe('moving measurements to another date', () => {
  it('a move applies, recomputes the moved ids and posts one note with Undo', async () => {
    load([m('a'), m('b'), m('c')]);
    const notes: unknown[] = [];
    const off = measureStore.subscribe((s, prev) => {
      if (s.note !== prev.note) notes.push(s.note);
    });
    const out = await moveMeasurementsToDate(['a', 'b'], 'jun');
    off();
    expect(out).toMatchObject({ ok: true, moved: 2 });
    expect(byId('a')?.scope).toEqual({ kind: 'survey', capture: 'jun' });
    expect(byId('a')?.source).toEqual({ layer: 'dsm-jun' });
    expect(byId('a')?.points.map((p) => p[2])).toEqual([50, 51, 52]);
    expect(byId('c')?.scope).toEqual({ kind: 'survey', capture: 'jan' });
    expect(computeAll).toHaveBeenCalledWith(['a', 'b']);
    expect(notes).toHaveLength(1);
    const note = measureStore.getState().note;
    expect(note).toMatchObject({
      text: t('tree.measure.move.done', { count: 2, date: formatDate('2026-06-01') }),
      danger: false,
      undo: true,
    });
    expect(out.ok && note?.seq).toBe(out.ok ? out.seq : -1);
    // an edit that waits for Save
    expect(measureStore.getState().savedText).not.toBe(
      JSON.stringify(measureStore.getState().file),
    );
  });

  it('Undo restores scope, source, folder, points and results', async () => {
    const before = [m('a', { folder: 'Roads', results: [result] } as Partial<SurveyMeasurement>)];
    load(before);
    const out = await moveMeasurementsToDate(['a'], 'jun');
    expect(byId('a')).not.toHaveProperty('folder');
    expect(byId('a')?.results[0]?.status).toBe('stale');
    undoMeasureChange(out.ok ? (out.seq ?? -1) : -1);
    expect(file()).toEqual(before);
    expect(measureStore.getState().note).toBeNull();
  });

  it('a refusal posts its text and changes nothing', async () => {
    load(
      [m('a', { source: { layer: 'cloud-jan' } })],
      LAYERS.filter((l) => l.id !== 'cloud-jun'),
    );
    const was = file();
    const out = await moveMeasurementsToDate(['a'], 'jun');
    expect(out).toEqual({
      ok: false,
      refusal: { kind: 'no-match', id: 'a', layer: 'cloud-jan' },
    });
    expect(file()).toBe(was);
    expect(measureStore.getState().note).toMatchObject({
      text: t('tree.measure.move.noMatch', { date: formatDate('2026-06-01'), layer: 'Cloud' }),
      danger: true,
    });
    expect(computeAll).not.toHaveBeenCalled();
  });

  it('refuses antenna measurements itself', async () => {
    load([m('a'), m('t', { tool: 'antenna-tilt', family: 'line' })]);
    const was = file();
    const out = await moveMeasurementsToDate(['a', 't'], 'jun');
    expect(out).toEqual({ ok: false, refusal: { kind: 'telecom' } });
    expect(file()).toBe(was);
    expect(measureStore.getState().note?.text).toBe(
      'Antenna measurements stay on the date they were picked on.',
    );
  });

  it('an unprepared target offers Prepare surfaces', async () => {
    load([m('a')]);
    compareStore.setState({ surfaces: [surface('s-jan', 'jan')] });
    const out = await moveMeasurementsToDate(['a'], 'jun');
    expect(out).toEqual({ ok: false, refusal: { kind: 'unprepared', capture: 'jun' } });
    expect(measureStore.getState().note).toMatchObject({ danger: true, prepare: true });
  });

  it('with no 3D stage a model vertex is refused with the switch-to-3D note and a ground-only move goes through', async () => {
    setMoveRepicker(null);
    load([
      m('model', { source: { layer: 'model-jan' }, pickedOn: ['model', 'ground', 'ground'] }),
      m('ground'),
    ]);
    const was = file();
    const refused = await moveMeasurementsToDate(['model', 'ground'], 'jun');
    expect(refused).toEqual({ ok: false, refusal: { kind: 'need-3d' } });
    expect(file()).toBe(was);
    expect(measureStore.getState().note?.text).toBe(t('tree.measure.move.need3d'));
    const ok = await moveMeasurementsToDate(['ground'], 'jun');
    expect(ok).toMatchObject({ ok: true, moved: 1 });
    expect(byId('ground')?.points.map((p) => p[2])).toEqual([7, 7, 7]);
  });

  /** A stage with one hidden layer root that records whether it was visible when cast at. */
  function fakeStage(layer: string, rayLayers: string[] = []) {
    const scene = new Scene();
    const group = new Group();
    group.userData.layerId = layer;
    group.visible = false;
    const root = new Mesh();
    group.add(root);
    scene.add(group);
    const seen: boolean[] = [];
    const raycastRay = vi.fn((o: Vector3, _d: Vector3, opts?: { layer?: string }) => {
      seen.push(group.visible);
      if (opts?.layer !== layer || !group.visible) return null;
      return { distance: 1, point: new Vector3(o.x, 42, o.z), object: root };
    });
    flags.scene = {
      scene,
      camera: { position: new Vector3(0, 100, 0) },
      raycastRay,
      rayLayers: () => new Set(rayLayers),
    };
    return { group, seen, raycastRay };
  }

  it('a hidden loaded mesh counterpart is picked without being shown', async () => {
    setMoveRepicker(null);
    load([m('a', { source: { layer: 'model-jan' }, pickedOn: ['model', 'model', 'ground'] })]);
    const { group, seen } = fakeStage('model-jun');
    const hidden = workspace.getState().hidden;
    const setLayerVisible = vi.spyOn(workspace.getState(), 'setLayerVisible');
    const out = await moveMeasurementsToDate(['a'], 'jun');
    expect(out).toMatchObject({ ok: true, moved: 1 });
    expect(seen).toEqual([true, true]);
    expect(group.visible).toBe(false);
    expect(workspace.getState().hidden).toBe(hidden);
    expect(setLayerVisible).not.toHaveBeenCalled();
    expect(byId('a')?.points.map((p) => p[2])).toEqual([42, 42, 7]);
    expect(byId('a')?.source).toEqual({ layer: 'model-jun' });
    setLayerVisible.mockRestore();
  });

  it('a hidden point cloud counterpart refuses with the show-it-first note and shows nothing', async () => {
    setMoveRepicker(null);
    load([m('a', { source: { layer: 'cloud-jan' }, pickedOn: ['model', 'model', 'model'] })]);
    const { group, raycastRay } = fakeStage('cloud-jun');
    const was = file();
    const out = await moveMeasurementsToDate(['a'], 'jun');
    expect(out).toEqual({ ok: false, refusal: { kind: 'hidden-layer', layer: 'cloud-jun' } });
    expect(file()).toBe(was);
    expect(raycastRay).not.toHaveBeenCalled();
    expect(group.visible).toBe(false);
    expect(measureStore.getState().note?.text).toBe(
      t('tree.measure.move.hiddenLayer', { layer: 'Cloud' }),
    );
  });

  it('a shown counterpart is cast at as it is', async () => {
    setMoveRepicker(null);
    load([m('a', { source: { layer: 'model-jan' }, pickedOn: ['model', 'model', 'model'] })]);
    const { group, seen } = fakeStage('model-jun', ['model-jun']);
    group.visible = true;
    const out = await moveMeasurementsToDate(['a'], 'jun');
    expect(out).toMatchObject({ ok: true, moved: 1 });
    expect(seen).toEqual([true, true, true]);
    expect(byId('a')?.points.map((p) => p[2])).toEqual([42, 42, 42]);
  });

  it('a copy to another date is measured again and the original stays', async () => {
    load([m('a', { results: [result] } as Partial<SurveyMeasurement>)]);
    const out = await copyMeasurementToDate('a', 'jun');
    expect(out).toMatchObject({ ok: true, moved: 1 });
    expect(file()).toHaveLength(2);
    expect(byId('a')?.scope).toEqual({ kind: 'survey', capture: 'jan' });
    const copy = file().find((x) => x.id !== 'a');
    expect(copy?.scope).toEqual({ kind: 'survey', capture: 'jun' });
    expect(copy?.source).toEqual({ layer: 'dsm-jun' });
    expect(copy?.points.map((p) => p[2])).toEqual([50, 51, 52]);
    expect(copy?.pickedOn).toEqual(['ground', 'ground', 'ground']);
    expect(copy?.results).toEqual([]);
    expect(copy).not.toHaveProperty('updatedAt');
    expect(computeAll).toHaveBeenCalledWith([copy?.id]);
  });
});

describe('measurements follow a layer put on another date', () => {
  let off: () => void = () => undefined;
  afterEach(() => {
    off();
  });
  const redate = (layer: string, capture: string) => {
    const manifest = workspace.getState().project?.manifest;
    if (!manifest) throw new Error('no project');
    workspace.getState().replaceManifest({
      ...manifest,
      layers: manifest.layers.map((l) => (l.id === layer ? { ...l, capture } : l)),
    });
  };

  it('a layer re-dated carries its measurements, heights unchanged, and they follow it back', () => {
    load([
      m('a', { source: { layer: 'model-jan' }, results: [result] } as Partial<SurveyMeasurement>),
      m('b'),
    ]);
    off = followLayerDates();
    redate('model-jan', 'jun');
    expect(byId('a')?.scope).toEqual({ kind: 'survey', capture: 'jun' });
    expect(byId('a')?.points).toEqual(pts);
    expect(byId('a')?.results[0]?.status).toBe('stale');
    expect(byId('b')?.scope).toEqual({ kind: 'survey', capture: 'jan' });
    expect(computeAll).toHaveBeenCalledWith(['a']);
    expect(measureStore.getState().undoChange).toBeNull();
    redate('model-jan', 'jan');
    expect(byId('a')?.scope).toEqual({ kind: 'survey', capture: 'jan' });
    expect(byId('a')?.points).toEqual(pts);
  });

  it('an antenna measurement follows its layer with values unchanged', () => {
    const tilt = m('t', {
      tool: 'antenna-tilt',
      family: 'line',
      source: { layer: 'model-jan' },
      points: [
        [1, 2, 3],
        [1, 2, 9],
      ],
      pickedOn: ['model', 'model'],
    });
    load([tilt]);
    off = followLayerDates();
    redate('model-jan', 'jun');
    expect(byId('t')?.scope).toEqual({ kind: 'survey', capture: 'jun' });
    expect(byId('t')?.points).toEqual(tilt.points);
  });

  it('a layer taken off every date leaves its measurements on their date', () => {
    load([m('a', { source: { layer: 'model-jan' } })]);
    off = followLayerDates();
    const manifest = workspace.getState().project?.manifest;
    if (!manifest) throw new Error('no project');
    workspace.getState().replaceManifest({
      ...manifest,
      layers: manifest.layers.map((l) => {
        if (l.id !== 'model-jan') return l;
        const out = { ...l };
        delete out.capture;
        return out;
      }),
    });
    expect(byId('a')?.scope).toEqual({ kind: 'survey', capture: 'jan' });
  });

  it('nothing moves or follows in a read-only project or for a look-only reviewer', async () => {
    for (const how of ['package', 'reviewer'] as const) {
      load([m('a', { source: { layer: 'model-jan' } })]);
      if (how === 'package') measureStore.setState({ readOnly: true });
      else flags.annotateReadOnly = true;
      const was = file();
      expect(await moveMeasurementsToDate(['a'], 'jun')).toEqual({ ok: true, moved: 0, seq: null });
      expect(await copyMeasurementToDate('a', 'jun')).toEqual({ ok: true, moved: 0, seq: null });
      off = followLayerDates();
      redate('model-jan', 'jun');
      off();
      expect(file()).toBe(was);
      expect(measureStore.getState().note).toBeNull();
      flags.annotateReadOnly = false;
    }
  });
});
