import { emptyOrientation, type OrientationFile, type ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import type { Fixes } from './alignTo';
import { createAlignToStore } from './alignToStore';
import { withPhotoFixes } from './orientationEdit';

const manifest = {
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'ph',
      name: 'Flight',
      visible: true,
      items: [
        { id: 'a', src: { path: 'a' }, pos: [91000, 40, 2000] },
        { id: 'b', src: { path: 'b' }, pos: [91000.2, 41, 2000.2] },
        { id: 'c', src: { path: 'c' } },
      ],
    },
    { kind: 'mesh', id: 'm', name: 'Site model', visible: true, src: { path: 'm' }, transform: [] },
    {
      kind: 'photos',
      id: 'drone',
      name: 'Drone',
      visible: true,
      items: [{ id: 'd', src: { path: 'd' }, pos: [0, 100, 0] }],
    },
  ],
} as unknown as ProjectManifest;

function setup(
  bounds: { min: [number, number, number]; max: [number, number, number] } | null = {
    min: [-1, 0, -1],
    max: [1, 2, 1],
  },
) {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'p', root: 'C:/p', manifest });
  ws.getState().setOrientation(emptyOrientation());
  const saved: Fixes[] = [];
  // like the app's save: the written file goes into the workspace
  const save = vi.fn((change: (file: OrientationFile | null) => Fixes): Promise<string | null> => {
    const f = change(ws.getState().orientation);
    saved.push(f);
    ws.getState().setOrientation(
      Object.entries(f).reduce(
        (file, [layerId, fx]) => withPhotoFixes(file, layerId, fx),
        ws.getState().orientation ?? emptyOrientation(),
      ),
    );
    return Promise.resolve(null);
  });
  const store = createAlignToStore({
    workspace: ws,
    save,
    bounds: () => Promise.resolve(bounds),
    ground: () => Promise.resolve(null),
    reload: vi.fn(),
  });
  return { store, save, saved, ws };
}

describe('alignTo store', () => {
  it('moves the set in one write and says how far, counting skipped photos', async () => {
    const { store, saved } = setup();
    await store.getState().alignTo({ layerIds: ['ph'] }, 'm');
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0]?.ph ?? {})).toEqual(['a', 'b']);
    expect(store.getState().notice?.text).toBe(
      'Aligned 2 photos to Site model (moved 91.0 km). 1 photo has no position and stayed where it was.',
    );
    expect(store.getState().notice?.action?.kind).toBe('undo');
  });

  it('undo writes back the previous corrections in one write, redo applies again', async () => {
    const { store, saved } = setup();
    await store.getState().alignTo({ layerIds: ['ph'] }, 'm');
    await store.getState().apply();
    expect(saved[1]).toEqual({ ph: { a: null, b: null } });
    expect(store.getState().notice?.action?.kind).toBe('redo');
    await store.getState().apply();
    expect(saved[2]).toEqual(saved[0]);
    expect(saved[2]?.ph?.a?.offsetM?.[0]).not.toBe(0);
  });

  it('a target without bounds writes nothing and says so', async () => {
    const { store, save } = setup(null);
    await store.getState().alignTo({ layerIds: ['ph'] }, 'm');
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toBe('Where Site model lies is not known.');
  });

  it('already in place writes nothing', async () => {
    const { store, save } = setup({ min: [90999, 0, 1999], max: [91001, 2, 2001] });
    await store.getState().alignTo({ picks: [{ layerId: 'ph', photoId: 'a' }] }, 'm');
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toBe('Already in place');
  });

  it('photos without a position write nothing and say so', async () => {
    const { store, save } = setup();
    await store.getState().alignTo({ picks: [{ layerId: 'ph', photoId: 'c' }] }, 'm');
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toBe('None of these photos has a position.');
  });

  it('undo keeps a rotation set after the alignment and restores only the offset', async () => {
    const { store, saved, ws } = setup();
    await store.getState().alignTo({ layerIds: ['ph'] }, 'm');
    const aligned = saved[0]?.ph?.a?.offsetM;
    ws.getState().setOrientation(
      withPhotoFixes(ws.getState().orientation, 'ph', {
        a: { yawDeg: 12, pitchDeg: 0, rollDeg: 0, offsetM: aligned },
      }),
    );
    await store.getState().apply();
    expect(saved[1]?.ph?.a).toEqual({ yawDeg: 12, pitchDeg: 0, rollDeg: 0, offsetM: [0, 0, 0] });
    expect(saved[1]?.ph?.b).toBeNull();
    await store.getState().apply();
    expect(saved[2]?.ph?.a).toEqual({ yawDeg: 12, pitchDeg: 0, rollDeg: 0, offsetM: aligned });
  });

  it('undo restores the exact previous correction when the photo had one', async () => {
    const { store, saved, ws } = setup();
    ws.getState().setOrientation(
      withPhotoFixes(ws.getState().orientation, 'ph', {
        a: { yawDeg: 5, pitchDeg: 1, rollDeg: 0, offsetM: [3, 0, 4] },
      }),
    );
    await store.getState().alignTo({ layerIds: ['ph'] }, 'm');
    expect(saved[0]?.ph?.a?.yawDeg).toBe(5);
    await store.getState().apply();
    expect(saved[1]?.ph?.a).toEqual({ yawDeg: 5, pitchDeg: 1, rollDeg: 0, offsetM: [3, 0, 4] });
  });

  it('ignores a second call while a write is under way, and keeps Undo after a failed write', async () => {
    const { store, save } = setup();
    await Promise.all([
      store.getState().alignTo({ layerIds: ['ph'] }, 'm'),
      store.getState().alignTo({ layerIds: ['ph'] }, 'm'),
    ]);
    expect(save).toHaveBeenCalledTimes(1);
    save.mockImplementationOnce(() => Promise.resolve('Disk full'));
    await store.getState().apply();
    expect(store.getState().notice?.text).toBe('Disk full');
    expect(store.getState().notice?.action?.kind).toBe('undo');
  });

  it('aligning to a drone photo set at 100 m with no DSM keeps the source heights', async () => {
    const { store, saved } = setup({ min: [0, 100, 0], max: [0, 100, 0] });
    await store.getState().alignTo({ layerIds: ['ph'] }, 'drone');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.ph?.a?.offsetM?.[1]).toBe(0);
    expect(saved[0]?.ph?.b?.offsetM?.[1]).toBe(0);
  });

  it('a project switch dismisses the notice, and its Undo afterwards writes nothing', async () => {
    const { store, saved, ws } = setup();
    await store.getState().alignTo({ layerIds: ['ph'] }, 'm');
    const old = store.getState().notice;
    expect(old?.projectId).toBe('p');
    ws.getState().openProject({ id: 'q', root: 'C:/q', manifest });
    ws.getState().setOrientation(emptyOrientation());
    expect(store.getState().notice).toBeNull();
    // a notice that outlived its project (shown again by a stale handle) refuses to write
    store.setState({ notice: old });
    await store.getState().apply();
    expect(saved).toHaveLength(1);
    expect(store.getState().notice).toBeNull();
  });

  it('a rejected lookup shows its message', async () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'p', root: 'C:/p', manifest });
    ws.getState().setOrientation(emptyOrientation());
    const s2 = createAlignToStore({
      workspace: ws,
      save: () => Promise.resolve(null),
      bounds: () => Promise.reject(new Error('No model')),
      ground: () => Promise.resolve(null),
      reload: vi.fn(),
    });
    await s2.getState().alignTo({ layerIds: ['ph'] }, 'm');
    expect(s2.getState().notice?.text).toBe('No model');
  });
});
