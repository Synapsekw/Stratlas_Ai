import { emptyOrientation, type ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import type { Fixes } from './alignTo';
import { createAlignToStore } from './alignToStore';
import { withPhotoFixes } from './orientationEdit';

const manifest = {
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
  const save = vi.fn((f: Fixes) => {
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
  return { store, save, saved };
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
});
