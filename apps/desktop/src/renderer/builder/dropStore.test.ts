import type { Layer, LayerPatch, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import type { Box } from '../shell/layerBounds';
import { createDropStore, type WalkFloor } from './dropStore';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const manifest = (layers: object[]) =>
  ({
    crs: { epsg: 32639 },
    origin: [500000, 4000000, 10],
    layers,
  }) as unknown as ProjectManifest;

const cloud = (id: string, name: string, extra: object = {}) => ({
  kind: 'pointcloud',
  id,
  name,
  visible: true,
  src: { path: `${id}.copc.laz` },
  format: 'copc',
  ...extra,
});
const model = (id: string, name: string) => ({
  kind: 'mesh',
  id,
  name,
  visible: true,
  src: { path: `${id}.glb` },
  transform: I,
});

const BOX: Box = { min: [0, 0, 0], max: [10, 5, 10] };

function setup(
  layers: object[] = [cloud('c', 'Cloud'), model('m', 'Model')],
  opts: {
    lows?: Record<string, number | null>;
    ground?: (x: number, z: number) => number | null;
    fail?: (layerId: string, n: number) => string | null;
    walkFloor?: (layerId: string) => WalkFloor;
  } = {},
) {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'p', root: 'C:/p', manifest: manifest(layers) });
  const saved: { layerId: string; patch: LayerPatch }[] = [];
  // like the app's save: the written patch goes into the manifest
  const save = vi.fn((layerId: string, patch: LayerPatch): Promise<string | null> => {
    const err = opts.fail?.(layerId, saved.length) ?? null;
    if (err) return Promise.resolve(err);
    saved.push({ layerId, patch });
    const m = ws.getState().project?.manifest;
    if (m)
      ws.getState().replaceManifest({
        ...m,
        layers: m.layers.map((l) => {
          if (l.id !== layerId) return l;
          const next = Object.fromEntries(
            Object.entries({ ...l, ...patch }).filter(([, v]) => v !== null),
          );
          return next as unknown as Layer;
        }),
      });
    return Promise.resolve(null);
  });
  const lows = opts.lows ?? { c: 31.2, m: 2 };
  const store = createDropStore({
    workspace: ws,
    save,
    low: (id) => Promise.resolve(lows[id] ?? null),
    footprint: () => Promise.resolve(BOX),
    ground: opts.ground ?? (() => null),
    walkFloor: (id) => Promise.resolve(opts.walkFloor?.(id) ?? 'notLoaded'),
  });
  return { store, save, saved, ws };
}

const layerOf = (ws: ReturnType<typeof createWorkspace>, id: string) =>
  ws.getState().project?.manifest.layers.find((l) => l.id === id) as unknown as Record<
    string,
    unknown
  >;

const placedWalk = (extra: object = {}) => ({
  kind: 'walk',
  id: 'walk-w1',
  name: 'Walk 1',
  visible: true,
  record: { path: 'walks/w1/walk.json' },
  src: { path: 'walks/w1/playback.mp4' },
  durationS: 10,
  place: {
    pins: [
      { t: 1, surface: '@model', at: [0, 0], y: 0 },
      { t: 9, surface: '@model', at: [9, 0], y: 0 },
    ],
    yawOffsetDeg: 0,
    heightM: 1.7,
    quality: 'good',
  },
  ...extra,
});

describe('drop store for walks', () => {
  it('raises a walk onto the floor drawn in 3D, with Undo and Redo', async () => {
    const { store, saved, ws } = setup([placedWalk()], { walkFloor: () => ({ shift: 1.25 }) });
    await store.getState().drop(['walk-w1']);
    expect(saved).toEqual([{ layerId: 'walk-w1', patch: { heightOffsetM: 1.25 } }]);
    expect(store.getState().notice?.text).toBe('Raised Walk 1 1.3 m (onto the floor in 3D).');
    expect(layerOf(ws, 'walk-w1').heightOffsetM).toBe(1.25);
    await store.getState().apply();
    expect(saved[1]).toEqual({ layerId: 'walk-w1', patch: { heightOffsetM: null } });
    expect(layerOf(ws, 'walk-w1').heightOffsetM).toBeUndefined();
    await store.getState().apply();
    expect(layerOf(ws, 'walk-w1').heightOffsetM).toBe(1.25);
  });

  it('drops a walk that is switched off: the floor under it is what is measured', async () => {
    const { store, saved, ws } = setup([placedWalk()], { walkFloor: () => ({ shift: 1.25 }) });
    ws.setState({ hidden: { 'walk-w1': true } });
    await store.getState().drop(['walk-w1']);
    expect(saved).toEqual([{ layerId: 'walk-w1', patch: { heightOffsetM: 1.25 } }]);
  });

  it('lowers a walk that has an offset by the floor below it', async () => {
    const { store, saved } = setup([placedWalk({ heightOffsetM: 2 })], {
      walkFloor: () => ({ shift: -6 }),
    });
    await store.getState().drop(['walk-w1']);
    expect(saved[0]?.patch).toEqual({ heightOffsetM: -4 });
    expect(store.getState().notice?.text).toBe('Lowered Walk 1 6.0 m (onto the floor in 3D).');
  });

  it('says so and writes nothing when no floor is drawn under the walk', async () => {
    const { store, save } = setup([placedWalk()], { walkFloor: () => 'noFloor' });
    await store.getState().drop(['walk-w1']);
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toBe(
      'Nothing is drawn in 3D under Walk 1. Show a model, a cloud or a DSM under it, then try again.',
    );
  });

  it('asks to wait while the walk has not been fitted yet', async () => {
    const { store, save } = setup([placedWalk()], { walkFloor: () => 'notLoaded' });
    await store.getState().drop(['walk-w1']);
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toContain('Walk 1 has not loaded yet');
  });

  it('sets a walk offset typed in Properties, with Undo', async () => {
    const { store, saved } = setup([placedWalk()]);
    await store.getState().setOffset('walk-w1', 1.5);
    expect(saved).toEqual([{ layerId: 'walk-w1', patch: { heightOffsetM: 1.5 } }]);
    expect(store.getState().notice?.text).toBe('Height offset of Walk 1 set to 1.5 m.');
    await store.getState().apply();
    expect(saved[1]).toEqual({ layerId: 'walk-w1', patch: { heightOffsetM: null } });
  });
});

describe('drop store', () => {
  it('drops two datasets and undoes both', async () => {
    const { store, saved, ws } = setup();
    await store.getState().drop(['c', 'm']);
    expect(saved.map((s) => s.layerId)).toEqual(['c', 'm']);
    expect(saved[0]?.patch).toEqual({ heightOffsetM: -31.2 });
    expect(store.getState().notice?.text).toBe(
      'Moved 2 datasets onto the ground (largest move 31.2 m).',
    );
    expect(store.getState().notice?.action?.kind).toBe('undo');
    expect(layerOf(ws, 'm').transform).toEqual([...I.slice(0, 13), -2, 0, 1]);

    await store.getState().apply();
    expect(saved.slice(2)).toEqual([
      { layerId: 'c', patch: { heightOffsetM: null } },
      { layerId: 'm', patch: { transform: I } },
    ]);
    expect(layerOf(ws, 'c').heightOffsetM).toBeUndefined();
    expect(store.getState().notice?.text).toBe('Drop undone.');
    expect(store.getState().notice?.action?.kind).toBe('redo');

    await store.getState().apply();
    expect(layerOf(ws, 'c').heightOffsetM).toBe(-31.2);
    expect(store.getState().notice?.text).toBe('Dropped again.');
    expect(store.getState().notice?.action?.kind).toBe('undo');
  });

  it('says Lowered for one cloud', async () => {
    const { store } = setup();
    await store.getState().drop(['c']);
    expect(store.getState().notice?.text).toBe(
      'Lowered Cloud 31.2 m (to the project ground level).',
    );
  });

  it('says Raised onto the DSM', async () => {
    const { store } = setup(undefined, { lows: { c: -4 }, ground: () => 1 });
    await store.getState().drop(['c']);
    expect(store.getState().notice?.text).toBe('Raised Cloud 5.0 m (on the DSM).');
  });

  it('says already on the ground', async () => {
    const { store, save } = setup(undefined, { lows: { c: 0.01 } });
    await store.getState().drop(['c']);
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toBe('Already on the ground');
    expect(store.getState().notice?.action).toBeNull();
  });

  it('refuses a cloud with no height samples', async () => {
    const { store, save } = setup(undefined, { lows: { c: null, m: 2 } });
    await store.getState().drop(['m', 'c']);
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toBe(
      'Cloud has not loaded yet. Show it, let it load, then try again.',
    );
  });

  it('names a hidden cloud and writes nothing', async () => {
    const { store, save, ws } = setup(undefined, { lows: { c: null, m: 2 } });
    ws.getState().setLayerVisible('c', false);
    await store.getState().drop(['m', 'c']);
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toBe('Cloud is hidden. Show it, then try again.');
  });

  it('names several hidden datasets', async () => {
    const { store, save, ws } = setup([
      cloud('c', 'Cloud'),
      cloud('d', 'Other'),
      model('m', 'Model'),
    ]);
    ws.getState().setLayerVisible('c', false);
    ws.getState().setLayerVisible('d', false);
    await store.getState().drop(['c', 'd', 'm']);
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toBe(
      'Cloud, Other are hidden. Show them, then try again.',
    );
  });

  it('refuses a kit-packed cloud', async () => {
    const { store, save } = setup([cloud('c', 'Cloud', { format: 'kit-packed' })]);
    await store.getState().drop(['c']);
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toBe('This cloud format cannot be moved.');
  });

  it('stops at a failed write and keeps undo for the ones done', async () => {
    const { store, saved } = setup(
      [cloud('c', 'Cloud'), model('m', 'Model'), cloud('d', 'Other')],
      { lows: { c: 31.2, m: 2, d: 3 }, fail: (id) => (id === 'm' ? 'Disk full' : null) },
    );
    await store.getState().drop(['c', 'm', 'd']);
    expect(saved.map((s) => s.layerId)).toEqual(['c']);
    const n = store.getState().notice;
    expect(n?.text).toBe('Disk full');
    expect(n?.action?.kind).toBe('undo');
    expect(n?.action?.steps.map((s) => s.layerId)).toEqual(['c']);
    await store.getState().apply();
    expect(saved.at(-1)).toEqual({ layerId: 'c', patch: { heightOffsetM: null } });
  });

  it('drops the notice and writes nothing when another project opens', async () => {
    const { store, save, ws } = setup();
    await store.getState().drop(['c']);
    expect(store.getState().notice).not.toBeNull();
    ws.getState().openProject({ id: 'q', root: 'C:/q', manifest: manifest([cloud('c', 'C')]) });
    expect(store.getState().notice).toBeNull();
    save.mockClear();
    await store.getState().apply();
    expect(save).not.toHaveBeenCalled();
  });

  it('writes nothing when another project opened while measuring', async () => {
    const { store, save, ws } = setup();
    const run = store.getState().drop(['c']);
    ws.getState().openProject({ id: 'q', root: 'C:/q', manifest: manifest([cloud('c', 'C')]) });
    await run;
    expect(save).not.toHaveBeenCalled();
  });

  it('sets an offset from Properties with undo', async () => {
    const { store, saved, ws } = setup([cloud('c', 'Cloud', { heightOffsetM: 2 })]);
    await store.getState().setOffset('c', -30.81);
    expect(saved).toEqual([{ layerId: 'c', patch: { heightOffsetM: -30.81 } }]);
    expect(store.getState().notice?.text).toBe('Height offset of Cloud set to -30.81 m.');
    await store.getState().apply();
    expect(saved.at(-1)).toEqual({ layerId: 'c', patch: { heightOffsetM: 2 } });
    expect(store.getState().notice?.action?.kind).toBe('redo');
    await store.getState().apply();
    expect(layerOf(ws, 'c').heightOffsetM).toBe(-30.81);
  });

  it('clears an offset and leaves an unchanged one alone', async () => {
    const { store, saved } = setup([cloud('c', 'Cloud', { heightOffsetM: 2 })]);
    await store.getState().setOffset('c', 2);
    expect(saved).toHaveLength(0);
    await store.getState().setOffset('c', null);
    expect(saved).toEqual([{ layerId: 'c', patch: { heightOffsetM: null } }]);
    expect(store.getState().notice?.text).toBe('Height offset of Cloud set to 0 m.');
  });
});
