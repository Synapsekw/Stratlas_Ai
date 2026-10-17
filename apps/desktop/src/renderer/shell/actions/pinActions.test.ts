// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, NO_HOST, type MenuTarget } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { begin } = vi.hoisted(() => ({ begin: vi.fn() }));
vi.mock('../../pins/placePin', () => ({
  pinSession: { getState: () => ({ begin }) },
  mediaName: (item: { id: string }) => item.id,
}));

const { registerPinActions } = await import('./pinActions');
const { builder } = await import('../../builder/state');
const { bridge, shell } = await import('../../shell');

const L = (o: Record<string, unknown>) => ({ visible: true, ...o });
const manifest = {
  captures: [],
  layers: [
    L({
      kind: 'photos',
      id: 'set',
      name: 'Set',
      items: [
        { id: 'loose', src: { path: 'photos/loose.jpg' } },
        { id: 'gps', src: { path: 'photos/gps.jpg' }, pos: [1, 2, 3] },
        {
          id: 'pinned',
          src: { path: 'photos/pinned.jpg' },
          pos: [1, 1.6, 3],
          pin: { ground: [1, 0, 3], eyeM: 1.6 },
        },
      ],
    }),
    L({
      kind: 'panoramas',
      id: 'panos',
      name: 'Panos',
      items: [
        { id: 'free', src: { path: 'panos/free.jpg' }, headingDeg: 0 },
        {
          id: 'sphere',
          src: { path: 'panos/sphere/pano.jpg' },
          pos: [0, 0, 0],
          headingDeg: 0,
          stitch: { status: 'done' },
        },
      ],
    }),
  ],
} as unknown as ProjectManifest;

const ctx = makeActionCtx({ manifest });
const pano = (itemId: string): MenuTarget => ({
  kind: 'media',
  picks: [{ kind: 'pano', layerId: 'panos', itemId }],
});
const photo = (photoId: string): MenuTarget => ({
  kind: 'photos',
  picks: [{ layerId: 'set', photoId }],
});
const ids = (tg: MenuTarget, c = ctx) => actionsFor(tg, c).map((i) => i.id);

let off: () => void;
beforeEach(() => {
  off = registerPinActions();
  begin.mockClear();
  workspace.setState({ project: { id: 'p', root: 'C:/p', manifest } } as unknown as Partial<
    ReturnType<typeof workspace.getState>
  >);
});
afterEach(() => {
  off();
  vi.restoreAllMocks();
});

describe('pin actions', () => {
  it('offers Place on site and Treat as photo on an unplaced 360, not Move or Remove', () => {
    const got = ids(pano('free'));
    expect(got).toContain('media.place');
    expect(got).toContain('media.asPhoto');
    expect(got).not.toContain('media.move');
    expect(got).not.toContain('media.remove');
    expect(got).not.toContain('media.as360');
  });

  it('keeps a stitched sphere a 360', () => {
    expect(ids(pano('sphere'))).not.toContain('media.asPhoto');
  });

  it('offers no pin action on a GPS photo with no pin (its GPS place is not corrected here)', () => {
    const got = ids(photo('gps'));
    expect(got).toContain('media.as360');
    for (const id of ['media.place', 'media.move', 'media.direction', 'media.remove'])
      expect(got).not.toContain(id);
  });

  it('offers Place on site alone on an unplaced photo', () => {
    const got = ids(photo('loose'));
    expect(got).toContain('media.place');
    expect(got).not.toContain('media.move');
    expect(got).not.toContain('media.direction');
  });

  it('offers Remove pin on a pinned photo', () => {
    expect(ids(photo('pinned'))).toEqual(
      expect.arrayContaining(['media.move', 'media.direction', 'media.remove']),
    );
  });

  it('offers nothing on several photos', () => {
    const tg: MenuTarget = {
      kind: 'photos',
      picks: [
        { layerId: 'set', photoId: 'gps' },
        { layerId: 'set', photoId: 'loose' },
      ],
    };
    expect(ids(tg).filter((id) => id.startsWith('media.'))).toEqual([]);
  });

  it('greys every action in a package with the package sentence', () => {
    const c = makeActionCtx({ manifest, pkg: true, canEdit: false });
    const items = [...actionsFor(pano('free'), c), ...actionsFor(photo('pinned'), c)].filter((i) =>
      i.id.startsWith('media.'),
    );
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i.disabled).toBe('A package cannot be changed.');
  });

  it('starts the placing session on Place on site, in the scene', () => {
    const go = vi.fn();
    shell.setState({ screen: 'media', go } as never);
    actionsFor(pano('free'), ctx)
      .find((i) => i.id === 'media.place')
      ?.run();
    expect(go).toHaveBeenCalledWith('scene');
    expect(begin).toHaveBeenCalledWith({ kind: 'pano', layerId: 'panos', itemId: 'free' }, 'place');
  });

  it('removes a pin by saving a null pin', async () => {
    const saveLayers = vi.fn(() => Promise.resolve(null));
    builder.setState({ saveLayers } as never);
    actionsFor(photo('pinned'), ctx)
      .find((i) => i.id === 'media.remove')
      ?.run();
    await Promise.resolve();
    expect(saveLayers).toHaveBeenCalledWith(['set'], {
      mediaPin: { itemId: 'pinned', pin: null },
    });
  });

  it('says why a remove failed', async () => {
    builder.setState({ saveLayers: vi.fn(() => Promise.resolve('Disk full')) } as never);
    const note = vi.fn();
    const c = makeActionCtx({ manifest, host: { ...NO_HOST, note } });
    actionsFor(photo('pinned'), c)
      .find((i) => i.id === 'media.remove')
      ?.run();
    await vi.waitFor(() => {
      expect(note).toHaveBeenCalledWith('Disk full', true);
    });
  });

  it('turns a photo into a 360 through the main process and shows the new manifest', async () => {
    const next = { ...manifest, layers: [] } as unknown as ProjectManifest;
    const call = vi.spyOn(bridge, 'call').mockResolvedValue({
      ok: true,
      value: { ok: true, manifest: next, layerId: 'x', itemId: 'y' },
    });
    actionsFor(photo('loose'), ctx)
      .find((i) => i.id === 'media.as360')
      ?.run();
    await vi.waitFor(() => {
      expect(workspace.getState().project?.manifest).toBe(next);
    });
    expect(call).toHaveBeenCalledWith('builder:convertMedia', {
      projectId: 'p',
      layerId: 'set',
      itemId: 'loose',
      to: 'pano',
    });
  });

  it('notes a refused conversion', async () => {
    vi.spyOn(bridge, 'call').mockResolvedValue({
      ok: true,
      value: { ok: false, error: 'This photo has marks on it. Remove them first.' },
    });
    const note = vi.fn();
    const c = makeActionCtx({ manifest, host: { ...NO_HOST, note } });
    actionsFor(pano('free'), c)
      .find((i) => i.id === 'media.asPhoto')
      ?.run();
    await vi.waitFor(() => {
      expect(note).toHaveBeenCalledWith('This photo has marks on it. Remove them first.', true);
    });
  });
});
