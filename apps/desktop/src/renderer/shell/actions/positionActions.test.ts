// @vitest-environment jsdom
import { emptyOrientation, type OrientationFile, type ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, type MenuTarget, type PhotoPick } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { open, reset } = vi.hoisted(() => ({ open: vi.fn(), reset: vi.fn() }));
vi.mock('../../builder/alignSession', () => ({
  positionEdit: { getState: () => ({ open, reset }) },
}));

const { registerPositionActions, menuPoint } = await import('./positionActions');

const manifest = {
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'set',
      name: 'Set',
      visible: true,
      items: [
        { id: 'a', src: { path: 'photos/a.jpg' }, pos: [1, 2, 3] },
        { id: 'b', src: { path: 'photos/b.jpg' }, pos: [4, 5, 6] },
        { id: 'loose', src: { path: 'photos/loose.jpg' } },
        {
          id: 'pinned',
          src: { path: 'photos/pinned.jpg' },
          pos: [1, 1.6, 3],
          pin: { ground: [1, 0, 3], eyeM: 1.6 },
        },
      ],
    },
  ],
} as unknown as ProjectManifest;

const ctx = makeActionCtx({ manifest });
const photos = (...ids: string[]): MenuTarget => ({
  kind: 'photos',
  picks: ids.map((photoId): PhotoPick => ({ layerId: 'set', photoId })),
});
const item = (tg: MenuTarget, id: string, c = ctx) => actionsFor(tg, c).find((i) => i.id === id);

const withOffset = (photoId: string, offsetM: [number, number, number]): OrientationFile => {
  const f = emptyOrientation();
  return {
    ...f,
    photos: { set: { [photoId]: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM } } },
  };
};

let off: () => void;
beforeEach(() => {
  off = registerPositionActions();
  open.mockClear();
  reset.mockClear();
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
  workspace.getState().setOrientation(emptyOrientation());
});
afterEach(() => {
  off();
});

describe('photos.editPosition', () => {
  it('is offered on one photo and opens the panel at the menu point', () => {
    window.dispatchEvent(new MouseEvent('contextmenu', { clientX: 120, clientY: 80 }));
    expect(menuPoint()).toEqual({ x: 120, y: 80 });
    const it1 = item(photos('a'), 'photos.editPosition');
    expect(it1?.disabled).toBe(false);
    expect(it1?.label).toBe('Edit position');
    expect(it1?.testId).toBe('ctx-item-photos.editPosition');
    it1?.run();
    expect(open).toHaveBeenCalledWith([{ layerId: 'set', photoId: 'a' }], { x: 120, y: 80 });
  });

  it('is offered on several photos', () => {
    const it2 = item(photos('a', 'b', 'pinned'), 'photos.editPosition');
    expect(it2?.disabled).toBe(false);
    it2?.run();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('is greyed with the pinned reason on a pinned photo', () => {
    expect(item(photos('pinned'), 'photos.editPosition')?.disabled).toBe('Pinned: use Move pin.');
  });

  it('is greyed with the not placed reason on a photo with no position', () => {
    expect(item(photos('loose'), 'photos.editPosition')?.disabled).toBe(
      'Not placed: use Place on site.',
    );
  });

  it('is greyed for a reviewer who may only look', () => {
    const ro = makeActionCtx({ manifest, canEdit: false });
    expect(item(photos('a'), 'photos.editPosition', ro)?.disabled).not.toBe(false);
  });
});

describe('photos.resetPosition', () => {
  it('is left out when no pick is edited', () => {
    expect(item(photos('a', 'b'), 'photos.resetPosition')).toBeUndefined();
  });

  it('is offered when a pick carries a position offset, and resets the picks', () => {
    workspace.getState().setOrientation(withOffset('b', [0, 5, 0]));
    const it3 = item(photos('a', 'b'), 'photos.resetPosition');
    expect(it3?.label).toBe('Reset to original');
    expect(it3?.disabled).toBe(false);
    it3?.run();
    expect(reset).toHaveBeenCalledWith([
      { layerId: 'set', photoId: 'a' },
      { layerId: 'set', photoId: 'b' },
    ]);
  });

  it('is left out for a rotation-only correction', () => {
    workspace.getState().setOrientation(withOffset('a', [0, 0, 0]));
    expect(item(photos('a'), 'photos.resetPosition')).toBeUndefined();
  });

  it('is greyed for a reviewer who may only look', () => {
    workspace.getState().setOrientation(withOffset('a', [0, 5, 0]));
    const ro = makeActionCtx({ manifest, canEdit: false });
    expect(item(photos('a'), 'photos.resetPosition', ro)?.disabled).not.toBe(false);
  });
});
