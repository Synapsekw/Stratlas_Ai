import { parsePyramid } from '@aio/globe';
import type { GlobeSite, ProjectManifest } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPyramids,
  focusSites,
  loadPyramid,
  outputRasters,
  pyramidKey,
  shownOf,
  useSiteOutputs,
} from './siteOutputsStore';

const INDEX = {
  schema: 'aio.tiles/1',
  corners: { tl: [0, 0, 0], tr: [10, 0, 0], bl: [0, 0, 10] },
  levels: [{ z: 0, tileSize: 256, cols: 1, rows: 1, pattern: '{z}/{x}/{y}.png' }],
};

const site: Pick<GlobeSite, 'projectId' | 'captures' | 'rasters'> = {
  projectId: 'p1',
  captures: [
    { id: 'c1', label: 'First', date: '2026-10-07' },
    { id: 'c2', label: 'Second', date: '2026-10-21' },
  ],
  rasters: [
    { layerId: 'o1', name: 'Ortho 1', role: 'ortho', src: 'a/tiles.json', capture: 'c1' },
    { layerId: 'o2', name: 'Ortho 2', role: 'ortho', src: 'b/tiles.json', capture: 'c2' },
    { layerId: 'h1', name: 'Heat', role: 'plan', src: 'c/tiles.json', change: true },
  ],
};

describe('focusSites', () => {
  it('is the open project, then the picked site when it is another one', () => {
    expect(focusSites('a', null)).toEqual(['a']);
    expect(focusSites('a', 'b')).toEqual(['a', 'b']);
    expect(focusSites('a', 'a')).toEqual(['a']);
    expect(focusSites(null, 'c')).toEqual(['c']);
    expect(focusSites(null, null)).toEqual([]);
  });
});

describe('the switches store', () => {
  beforeEach(() => {
    useSiteOutputs.setState({ shown: {} });
  });

  it('shows the defaults while the person has touched nothing', () => {
    expect(useSiteOutputs.getState().shown.p1).toBeUndefined();
    expect(shownOf(useSiteOutputs.getState().shown, site)).toEqual(['o2']);
  });

  it('copies the defaults first, then flips the one id', () => {
    useSiteOutputs.getState().toggle(site, 'h1');
    expect(useSiteOutputs.getState().shown.p1).toEqual(['o2', 'h1']);
    useSiteOutputs.getState().toggle(site, 'o2');
    expect(useSiteOutputs.getState().shown.p1).toEqual(['h1']);
    expect(shownOf(useSiteOutputs.getState().shown, site)).toEqual(['h1']);
  });

  it('keeps each project on its own', () => {
    useSiteOutputs.getState().toggle(site, 'o1');
    expect(useSiteOutputs.getState().shown.p2).toBeUndefined();
  });
});

describe('loadPyramid', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearPyramids();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the index over aio://project, once per project and source', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(INDEX) });
    const a = await loadPyramid('my project', 'raster/o 1/tiles.json');
    const b = await loadPyramid('my project', 'raster/o 1/tiles.json');
    expect(a?.levels).toHaveLength(1);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('aio://project/my%20project/raster/o%201/tiles.json');
    expect(
      useSiteOutputs.getState().indexes[pyramidKey('my project', 'raster/o 1/tiles.json')],
    ).toBe(a);
  });

  it('gives null for a missing, failing or foreign index', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: () => Promise.resolve(null) });
    expect(await loadPyramid('p', 'missing.json')).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error('gone'));
    expect(await loadPyramid('p', 'broken.json')).toBeNull();
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ schema: 'x' }) });
    expect(await loadPyramid('p', 'other.json')).toBeNull();
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.reject(new Error('bad')) });
    expect(await loadPyramid('p', 'corrupt.json')).toBeNull();
    expect(useSiteOutputs.getState().indexes[pyramidKey('p', 'missing.json')]).toBeNull();
  });

  it('forgets the indexes when the Globe closes', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(INDEX) });
    await loadPyramid('p', 'a.json');
    clearPyramids();
    expect(useSiteOutputs.getState().indexes).toEqual({});
    await loadPyramid('p', 'a.json');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops a read that lands after the Globe closed', async () => {
    let land: (v: unknown) => void = () => undefined;
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        land = done;
      }),
    );
    const pending = loadPyramid('p', 'late.json');
    clearPyramids();
    land({ ok: true, json: () => Promise.resolve(INDEX) });
    await pending;
    expect(useSiteOutputs.getState().indexes).toEqual({});
  });
});

describe('outputRasters', () => {
  const index = parsePyramid(INDEX);
  const manifest = {
    captures: [
      { id: 'c1', label: 'First', date: '2026-10-07' },
      {
        id: 'c2',
        label: 'Second',
        date: '2026-10-21',
        lineUp: { eastM: 2, northM: -1, with: 'c1', at: '2026-10-22T00:00:00.000Z' },
      },
    ],
    layers: [
      { id: 'o1', name: 'Ortho 1', kind: 'raster', capture: 'c1' },
      { id: 'o2', name: 'Ortho 2', kind: 'raster', capture: 'c2' },
    ],
  } as unknown as Pick<ProjectManifest, 'captures' | 'layers'>;
  const indexes = {
    [pyramidKey('p1', 'a/tiles.json')]: index,
    [pyramidKey('p1', 'b/tiles.json')]: index,
  };

  it('passes the date shift of each raster', () => {
    const out = outputRasters('p1', site.rasters ?? [], indexes, manifest);
    expect(out.map((r) => [r.layerId, r.shift])).toEqual([
      ['o1', undefined],
      ['o2', { eastM: 2, northM: -1 }],
    ]);
  });

  it('leaves out a raster whose index is not read, and shifts nothing without a manifest', () => {
    const out = outputRasters('p1', site.rasters ?? [], indexes, null);
    expect(out.map((r) => r.layerId)).toEqual(['o1', 'o2']);
    expect(out.every((r) => r.shift === undefined)).toBe(true);
    expect(outputRasters('p1', site.rasters ?? [], {}, manifest)).toEqual([]);
  });
});
