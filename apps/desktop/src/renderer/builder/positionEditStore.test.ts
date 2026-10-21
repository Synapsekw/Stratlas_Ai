import { offsetForPosition, shiftToOffset, siteXYZ } from '@aio/geo';
import {
  emptyOrientation,
  type OrientationFile,
  type PhotoCorrection,
  type ProjectManifest,
} from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import type { Fixes } from './alignTo';
import { withPhotoFixes } from './orientationEdit';
import { createPositionEditStore, editablePicks, editReason } from './positionEditStore';

const ORIGIN: [number, number, number] = [500000, 4000000, 12];

const manifest = {
  origin: ORIGIN,
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'ph',
      name: 'Flight',
      visible: true,
      items: [
        { id: 'a', src: { path: 'a' }, pos: [10, 40, -20] },
        { id: 'b', src: { path: 'b' }, pos: [11, 41, -21] },
        { id: 'c', src: { path: 'c' } },
        {
          id: 'p',
          src: { path: 'p' },
          pos: [5, 30, 5],
          pin: { pos: [6, 0, 6] },
        },
      ],
    },
  ],
} as unknown as ProjectManifest;

const pick = (photoId: string) => ({ layerId: 'ph', photoId });

function setup(opts: { pkg?: boolean; loaded?: boolean; fail?: string } = {}) {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'p1', root: 'C:/p', manifest });
  ws.getState().setOrientation(emptyOrientation(), opts.loaded ?? true);
  const saved: Fixes[] = [];
  // like the app's save: the written file goes into the workspace
  const save = vi.fn((change: (file: OrientationFile | null) => Fixes): Promise<string | null> => {
    if (opts.fail) return Promise.resolve(opts.fail);
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
  const reload = vi.fn();
  const store = createPositionEditStore({
    workspace: ws,
    save,
    pkg: () => opts.pkg ?? false,
    reload,
  });
  const fix = (id: string, c: PhotoCorrection | null) => {
    ws.getState().setOrientation(withPhotoFixes(ws.getState().orientation, 'ph', { [id]: c }));
  };
  const entry = (id: string) => ws.getState().orientation?.photos.ph?.[id];
  return { store, save, saved, ws, fix, entry, reload };
}

describe('editablePicks', () => {
  it('splits picks into editable, pinned and not placed', () => {
    const split = editablePicks([pick('a'), pick('c'), pick('p'), pick('gone')], manifest);
    expect(split.editable).toEqual([pick('a')]);
    expect(split.pinned).toEqual([pick('p')]);
    // a pick no longer in the project counts as not placed
    expect(split.unplaced).toEqual([pick('c'), pick('gone')]);
    expect(editReason(split)).toBe(false);
  });

  it('gives the reason when nothing is editable', () => {
    expect(editReason(editablePicks([pick('p')], manifest))).toBe('Pinned: use Move pin.');
    expect(editReason(editablePicks([pick('c')], manifest))).toBe('Not placed: use Place on site.');
    expect(editReason(editablePicks([], manifest))).toBe('Not placed: use Place on site.');
  });
});

describe('positionEdit store', () => {
  it('opens one placed photo with its corrected and imported positions', () => {
    const { store, fix } = setup();
    fix('a', { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [1, 2, 3] });
    expect(store.getState().open([pick('a')], { x: 5, y: 6 })).toBeNull();
    const panel = store.getState().panel;
    expect(panel?.mode).toBe('one');
    if (panel?.mode !== 'one') return;
    expect(panel.current).toEqual(siteXYZ([11, 42, -17], ORIGIN));
    expect(panel.original).toEqual(siteXYZ([10, 40, -20], ORIGIN));
    expect(panel.edited).toBe(true);
    expect(panel.at).toEqual({ x: 5, y: 6 });
  });

  it('opens several and counts pinned and not placed picks as skipped', () => {
    const { store } = setup();
    store.getState().open([pick('a'), pick('b'), pick('c'), pick('p')]);
    const panel = store.getState().panel;
    expect(panel).toMatchObject({ mode: 'many', count: 2, skipped: 2 });
  });

  it('refuses with the reason when no pick can be edited', () => {
    const { store } = setup();
    expect(store.getState().open([pick('p')])).toBe('Pinned: use Move pin.');
    expect(store.getState().panel).toBeNull();
    expect(store.getState().open([pick('c')])).toBe('Not placed: use Place on site.');
  });

  it('refuses in a package and while the corrections are not read', () => {
    const pkg = setup({ pkg: true }).store;
    expect(pkg.getState().open([pick('a')])).toBe('This is a package: its files stay inside it.');
    expect(pkg.getState().panel).toBeNull();
    const unread = setup({ loaded: false });
    expect(unread.store.getState().open([pick('a')])).toMatch(/have not been read yet/);
    expect(unread.reload).toHaveBeenCalled();
    expect(unread.store.getState().panel).toBeNull();
  });

  it('saves one photo as offset = typed minus imported, keeping its rotations', async () => {
    const { store, saved, entry, fix } = setup();
    fix('a', { yawDeg: 5, pitchDeg: 0, rollDeg: 0 });
    store.getState().open([pick('a')]);
    const typed = { x: 12, y: 25, z: 60 };
    await store.getState().save(typed);
    expect(saved).toHaveLength(1);
    expect(entry('a')).toEqual({
      yawDeg: 5,
      pitchDeg: 0,
      rollDeg: 0,
      offsetM: offsetForPosition([10, 40, -20], ORIGIN, typed),
    });
    expect(store.getState().panel).toBeNull();
    expect(store.getState().notice?.text).toBe('Moved 1 photo.');
    expect(store.getState().notice?.action?.kind).toBe('undo');
  });

  it('saving one photo where it already is writes nothing and raises no notice', async () => {
    const { store, saved, fix } = setup();
    fix('a', { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [1, 2, 3] });
    store.getState().open([pick('a')]);
    const here = siteXYZ([11, 42, -17], ORIGIN);
    await store.getState().save({ ...here, x: here.x + 2e-4 });
    expect(saved).toHaveLength(0);
    expect(store.getState().panel).toBeNull();
    expect(store.getState().notice).toBeNull();
    // unedited photo at its imported place: the same
    store.getState().open([pick('b')]);
    await store.getState().save(siteXYZ([11, 41, -21], ORIGIN));
    expect(saved).toHaveLength(0);
    expect(store.getState().notice).toBeNull();
  });

  it('typing the imported values back removes the entry', async () => {
    const { store, entry, fix } = setup();
    fix('a', { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [1, 2, 3] });
    store.getState().open([pick('a')]);
    await store.getState().save(siteXYZ([10, 40, -20], ORIGIN));
    expect(entry('a')).toBeUndefined();
  });

  it('saves several by adding the shift to each offset; a zero shift writes nothing', async () => {
    const { store, saved, entry, fix } = setup();
    fix('a', { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [1, 0, 0] });
    store.getState().open([pick('a'), pick('b'), pick('p')]);
    await store.getState().save({ x: 0, y: 0, z: 0 });
    expect(saved).toHaveLength(0);
    expect(store.getState().panel).toBeNull();

    store.getState().open([pick('a'), pick('b'), pick('p')]);
    const shift = { x: 1, y: 2, z: -3 };
    await store.getState().save(shift);
    const o = shiftToOffset(shift);
    expect(saved).toHaveLength(1);
    expect(entry('a')?.offsetM).toEqual([1 + o[0], o[1], o[2]]);
    expect(entry('b')?.offsetM).toEqual(o);
    expect(entry('p')).toBeUndefined();
    expect(store.getState().notice?.text).toBe('Moved 2 photos.');
  });

  it('reset removes the offset, and the entry when no rotation is left', async () => {
    const { store, entry, fix } = setup();
    fix('a', { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [1, 0, 0] });
    fix('b', { yawDeg: 3, pitchDeg: 0, rollDeg: 0, offsetM: [1, 0, 0] });
    await store.getState().reset([pick('a'), pick('b')]);
    expect(entry('a')).toBeUndefined();
    expect(entry('b')).toEqual({ yawDeg: 3, pitchDeg: 0, rollDeg: 0 });
    expect(store.getState().notice?.text).toBe('Put 2 photos back where they were imported.');
  });

  it('undo after Save many restores each previous correction exactly, redo re-applies', async () => {
    const { store, saved, entry, fix } = setup();
    const before: PhotoCorrection = { yawDeg: 2, pitchDeg: 1, rollDeg: 0, offsetM: [1, 0, 0] };
    fix('a', before);
    store.getState().open([pick('a'), pick('b')]);
    await store.getState().save({ x: 1, y: 1, z: 1 });
    const after = { a: entry('a'), b: entry('b') };
    await store.getState().apply();
    expect(saved).toHaveLength(2);
    expect(entry('a')).toEqual(before);
    expect(entry('b')).toBeUndefined();
    expect(store.getState().notice?.text).toBe('Undid the position change.');
    expect(store.getState().notice?.action?.kind).toBe('redo');
    await store.getState().apply();
    expect(entry('a')).toEqual(after.a);
    expect(entry('b')).toEqual(after.b);
    expect(store.getState().notice?.text).toBe('Redid the position change.');
  });

  it('a notice raised for another project writes nothing', async () => {
    const { store, saved, ws } = setup();
    store.getState().open([pick('a')]);
    await store.getState().save({ x: 1, y: 1, z: 20 });
    // the open project changes behind the notice's back without the subscription firing first
    store.setState({
      notice: { ...(store.getState().notice ?? { text: '', action: null }), projectId: 'other' },
    });
    await store.getState().apply();
    expect(saved).toHaveLength(1);
    expect(store.getState().notice).toBeNull();
    // a project switch takes the notice and the panel away
    store.getState().open([pick('a')]);
    ws.getState().openProject({ id: 'p2', root: 'C:/q', manifest });
    expect(store.getState().panel).toBeNull();
  });

  it('a reload of the corrections (a re-read, a pose swap) takes the notice and the panel away', async () => {
    const { store, ws } = setup();
    store.getState().open([pick('a')]);
    await store.getState().save({ x: 1, y: 1, z: 20 });
    expect(store.getState().notice?.action?.kind).toBe('undo');
    store.getState().open([pick('b')]);
    // its own writes leave them be
    ws.getState().setOrientation(ws.getState().orientation);
    expect(store.getState().notice).not.toBeNull();
    expect(store.getState().panel).not.toBeNull();
    // loadOrientation starts by dropping the file: the stored offsets no longer hold
    ws.getState().setOrientation(null, false);
    expect(store.getState().notice).toBeNull();
    expect(store.getState().panel).toBeNull();
  });

  it("the panel's exact X and Y with a new Z move an unedited photo up only", async () => {
    const { store, entry } = setup();
    store.getState().open([pick('a')]);
    const panel = store.getState().panel;
    if (panel?.mode !== 'one') throw new Error('one photo');
    await store.getState().save({ ...panel.current, z: panel.current.z + 2.5 });
    expect(entry('a')?.offsetM).toEqual([0, 2.5, 0]);
  });

  it('a write error shows its text and leaves the notice without Undo', async () => {
    const { store } = setup({ fail: 'Disk full' });
    store.getState().open([pick('a')]);
    await store.getState().save({ x: 1, y: 1, z: 20 });
    expect(store.getState().notice).toMatchObject({ text: 'Disk full', action: null });
  });
});
