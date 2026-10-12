import { ProjectManifest, type WalkLayer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';

const call = vi.hoisted(() => vi.fn());
vi.mock('../shell', () => ({
  bridge: { call },
  shell: { getState: () => ({ screen: 'scene', stageMode: 'split', go: vi.fn() }) },
}));
vi.mock('../builder/state', () => ({
  builder: { getState: () => ({}), subscribe: () => () => undefined },
}));

import { removeWalk, walks } from './walks';

const walkLayer = (id: string): WalkLayer => ({
  kind: 'walk',
  id: `walk-${id}`,
  name: id,
  visible: true,
  record: { path: `walks/${id}/walk.json` },
  src: { path: `walks/${id}/playback.mp4` },
  durationS: 12,
});

const manifest = (layers: WalkLayer[]) =>
  ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32633 },
    origin: [500000, 4500000, 0],
    captures: [],
    layers,
    severityModels: [],
    classCatalogues: [],
  });

async function openWith(ids: string[]): Promise<void> {
  call.mockImplementation((channel: string) =>
    Promise.resolve(
      channel === 'walks:list' ? { ok: true, value: { walks: [] } } : { ok: false, error: '?' },
    ),
  );
  workspace
    .getState()
    .openProject({ id: 'p', root: 'C:/p', manifest: manifest(ids.map(walkLayer)) });
  await walks.getState().sync('p', workspace.getState().project?.manifest.layers ?? []);
}

afterEach(() => {
  workspace.getState().closeProject();
  call.mockReset();
});

describe('removeWalk', () => {
  it('lets the 360 pane go of the shown walk before main moves its files', async () => {
    await openWith(['a', 'b']);
    walks.getState().select('walk-a');
    let shownWhenAsked: unknown = 'not asked';
    call.mockImplementation((channel: string) => {
      if (channel !== 'walks:remove') return Promise.resolve({ ok: true, value: { walks: [] } });
      const s = walks.getState();
      shownWhenAsked = { selected: s.selected, ids: s.walks.map((w) => w.id) };
      return Promise.resolve({
        ok: true,
        value: { ok: true, manifest: manifest([walkLayer('b')]) },
      });
    });
    expect(await removeWalk('walk-a')).toBeNull();
    expect(shownWhenAsked).toEqual({ selected: null, ids: ['walk-b'] });
    expect(workspace.getState().project?.manifest.layers.map((l) => l.id)).toEqual(['walk-b']);
  });

  it('brings the walk back to the list when main refuses', async () => {
    await openWith(['a', 'b']);
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'walks:remove'
          ? { ok: true, value: { ok: false, error: 'held open' } }
          : { ok: true, value: { walks: [] } },
      ),
    );
    expect(await removeWalk('walk-a')).toBe('held open');
    await vi.waitFor(() => {
      expect(walks.getState().walks.map((w) => w.id)).toEqual(['walk-a', 'walk-b']);
    });
  });
});
