import { emptyOrientation, type Layer, type ProjectManifest } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  boundsOf,
  groundAt,
  knowsWhere,
  layerBounds,
  padBox,
  unionBox,
  type BoundsDeps,
  type Box,
} from './layerBounds';

const manifest = {
  captures: [],
  layers: [
    { kind: 'mesh', id: 'm', name: 'M', visible: true, src: { path: 'm.glb' }, transform: [] },
    {
      kind: 'photos',
      id: 'ph',
      name: 'P',
      visible: true,
      items: [
        { id: 'a', src: { path: 'a' }, pos: [10, 1, 10] },
        { id: 'b', src: { path: 'b' }, pos: [12, 3, 14] },
      ],
    },
    {
      kind: 'raster',
      id: 'img',
      name: 'I',
      visible: true,
      src: { path: 'i.png' },
      role: 'plan',
      format: 'image',
      corners: { tl: [0, 0, 0], tr: [4, 0, 0], bl: [0, 0, 2] },
    },
    {
      kind: 'raster',
      id: 'dsm',
      name: 'D',
      visible: true,
      src: { path: 'd.tif' },
      role: 'dsm',
      format: 'cog',
    },
    {
      kind: 'panoramas',
      id: 'pn',
      name: 'N',
      visible: true,
      items: [{ id: 'x', src: { path: 'x' }, pos: [5, 0, 5], headingDeg: 0 }],
    },
    { kind: 'basemap', id: 'bm', name: 'B', visible: true, pack: 'p', style: 'dark' },
  ],
} as unknown as ProjectManifest;

const deps = (over: Partial<BoundsDeps> = {}): BoundsDeps => ({
  manifest,
  orientation: null,
  sceneBox: (id) => (id === 'm' ? { min: [-1, 0, -1], max: [1, 2, 1] } : null),
  fileExtent: vi.fn((id: string): Promise<Box | null> =>
    Promise.resolve(id === 'dsm' ? { min: [-50, 0, -50], max: [50, 9, 50] } : null),
  ),
  rayDown: () => 4,
  ...over,
});

describe('layerBounds', () => {
  it('reads models from the scene, photos from corrected positions, images from corners', async () => {
    expect(await layerBounds('m', deps())).toEqual({ min: [-1, 0, -1], max: [1, 2, 1] });
    expect(await layerBounds('ph', deps())).toEqual({ min: [10, 1, 10], max: [12, 3, 14] });
    const o = {
      ...emptyOrientation(),
      photos: {
        ph: {
          a: {
            yawDeg: 0,
            pitchDeg: 0,
            rollDeg: 0,
            offsetM: [-10, 0, -10] as [number, number, number],
          },
        },
      },
    };
    expect(await layerBounds('ph', deps({ orientation: o }))).toEqual({
      min: [0, 1, 0],
      max: [12, 3, 14],
    });
    expect(await layerBounds('img', deps())).toEqual({ min: [0, 0, 0], max: [4, 0, 2] });
    expect(await layerBounds('pn', deps())).toEqual({ min: [5, 0, 5], max: [5, 0, 5] });
  });

  it('asks main for COGs, and for a model the scene has not drawn', async () => {
    const fileExtent = vi.fn((id: string): Promise<Box | null> =>
      Promise.resolve(id === 'dsm' ? { min: [-50, 0, -50], max: [50, 9, 50] } : null),
    );
    const d = deps({ sceneBox: () => null, fileExtent });
    expect(await layerBounds('dsm', d)).toEqual({ min: [-50, 0, -50], max: [50, 9, 50] });
    await layerBounds('m', d);
    expect(fileExtent).toHaveBeenCalledWith('m');
    expect(await layerBounds('bm', d)).toBeNull();
  });

  it('frames the union of several datasets and pads a single point', async () => {
    expect(await boundsOf(['m', 'pn'], deps())).toEqual({ min: [-1, 0, -1], max: [5, 2, 5] });
    expect(unionBox([null, null])).toBeNull();
    expect(padBox({ min: [5, 0, 5], max: [5, 0, 5] })).toEqual({
      min: [0, -5, 0],
      max: [10, 5, 10],
    });
  });

  it('knows which kinds can say where they lie without reading files', () => {
    const ls = manifest.layers;
    expect(ls.map((l) => knowsWhere(l))).toEqual([true, true, true, true, true, false]);
  });

  it('takes the ground from a ray only where a DSM covers the point', async () => {
    expect(await groundAt(0, 0, deps())).toBe(4);
    expect(await groundAt(500, 0, deps())).toBeNull();
    expect(await groundAt(0, 0, deps({ rayDown: () => null }))).toBeNull();
  });

  it('a walk knows where it lies once its path is placed, not from pins alone', () => {
    const walk = (o: object) =>
      ({ kind: 'walk', id: 'w', name: 'W', visible: true, ...o }) as unknown as Layer;
    expect(knowsWhere(walk({ place: { pins: [{}, {}], quality: 'good' } }))).toBe(false);
    expect(
      knowsWhere(
        walk({ place: { pins: [{}, {}] }, flight: { src: { path: 'f' }, startUtcMs: 1 } }),
      ),
    ).toBe(true);
  });

  it('casts the ground ray against the DSM layer only', async () => {
    const rayDown = vi.fn(() => 4);
    await groundAt(1, 2, deps({ rayDown }));
    expect(rayDown).toHaveBeenCalledWith(1, 2, 'dsm');
  });
});

describe('an unplaced 360', () => {
  const mk = (items: unknown[]) =>
    ({ kind: 'panoramas', id: 'pu', name: 'U', visible: true, items }) as unknown as Layer;
  const a = { id: 'a', src: { path: 'a' }, pos: [10, 0, 0], headingDeg: 0 };
  const b = { id: 'b', src: { path: 'b' }, headingDeg: 0 };
  it('is no place by itself and does not widen the bounds', async () => {
    expect(knowsWhere(mk([b]))).toBe(false);
    expect(knowsWhere(mk([a, b]))).toBe(true);
    const m = { captures: [], layers: [mk([a, b])] } as unknown as ProjectManifest;
    const m1 = { captures: [], layers: [mk([a])] } as unknown as ProjectManifest;
    expect(await layerBounds('pu', deps({ manifest: m }))).toEqual(
      await layerBounds('pu', deps({ manifest: m1 })),
    );
  });
});

describe('layerBounds with a line-up', () => {
  const lined = {
    captures: [
      {
        id: 'd1',
        label: 'd1',
        date: '2025-01-01',
        lineUp: { eastM: 3, northM: 1, with: 'd0', at: '2026-01-01T00:00:00Z' },
      },
    ],
    layers: manifest.layers.map((l) => (l.kind === 'basemap' ? l : { ...l, capture: 'd1' })),
  } as unknown as ProjectManifest;
  const d = deps({ manifest: lined });
  it('frames a lined-up raster at its corrected place', async () => {
    expect(await layerBounds('img', d)).toEqual({ min: [3, 0, -1], max: [7, 0, 1] });
  });
  it('frames lined-up photos and panoramas at their corrected place', async () => {
    expect(await layerBounds('ph', d)).toEqual({ min: [13, 1, 9], max: [15, 3, 13] });
    expect(await layerBounds('pn', d)).toEqual({ min: [8, 0, 4], max: [8, 0, 4] });
  });
});
