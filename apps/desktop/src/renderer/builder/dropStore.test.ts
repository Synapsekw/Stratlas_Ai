import type { Layer, LayerPatch, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import type { Box } from '../shell/layerBounds';
import { createDropStore } from './dropStore';

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
  });
  return { store, save, saved, ws };
}

const layerOf = (ws: ReturnType<typeof createWorkspace>, id: string) =>
  ws.getState().project?.manifest.layers.find((l) => l.id === id) as unknown as Record<
    string,
    unknown
  >;

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
