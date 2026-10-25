import type { BaseSpec, HeightTiles, ProjectManifest } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../shell', () => ({ bridge: { call: vi.fn() } }));
vi.mock('../author', () => ({ authorName: () => '' }));

const { groundVertices, interpolateRun, levelVertices, moveVertices, runOf } =
  await import('./BaseEditor');
const { prepareParams } = await import('./compareStore');

type Custom = Extract<BaseSpec, { kind: 'custom' }>;

describe('custom base edits', () => {
  const base: Custom = {
    kind: 'custom',
    vertices: [
      { e: 0, n: 0, z: 10 },
      { e: 10, n: 0, offsetM: -0.5 },
      { e: 10, n: 10, z: 12 },
    ],
  };

  it('moves the selected vertices: a level by its level, an offset by its offset', () => {
    const moved = moveVertices(base, new Set([0, 1]), 0.25);
    expect(moved.vertices).toEqual([
      { e: 0, n: 0, z: 10.25 },
      { e: 10, n: 0, offsetM: -0.25 },
      { e: 10, n: 10, z: 12 },
    ]);
  });

  it('sets the selected vertices to one level (offsets become levels)', () => {
    const set = levelVertices(base, new Set([1, 2]), 9);
    expect(set.vertices).toEqual([
      { e: 0, n: 0, z: 10 },
      { e: 10, n: 0, z: 9 },
      { e: 10, n: 10, z: 9 },
    ]);
  });
});

describe('custom base: ground and interpolate', () => {
  // a 4 m by 4 m square traced with 8 vertices, 2 m apart along the edge
  const ring: [number, number][] = [
    [0, 0],
    [2, 0],
    [4, 0],
    [4, 2],
    [4, 4],
    [2, 4],
    [0, 4],
    [0, 2],
  ];
  const base: Custom = {
    kind: 'custom',
    vertices: ring.map(([e, n], k) => (k === 4 ? { e, n, offsetM: 0.5 } : { e, n, z: 100 + k })),
  };
  // the height under each vertex as drawn (the polygon's own Z)
  const drawn = (k: number) => 200 + k;

  it('Use ground here makes the selected vertices follow the surface under them', () => {
    const g = groundVertices(base, new Set([1, 4]));
    expect(g.vertices[1]).toEqual({ e: 2, n: 0, offsetM: 0 });
    expect(g.vertices[4]).toEqual({ e: 4, n: 4, offsetM: 0 });
    expect(g.vertices[0]).toEqual(base.vertices[0]);
  });

  it('finds one run of selected vertices and its neighbours outside it, round the ring', () => {
    expect(runOf(new Set([2, 3]), 8)).toEqual({ before: 1, run: [2, 3], after: 4 });
    // a run across the ring's start
    expect(runOf(new Set([7, 0, 1]), 8)).toEqual({ before: 6, run: [7, 0, 1], after: 2 });
    // two runs, nothing, everything, or all but one: no straight line to draw
    expect(runOf(new Set([1, 3]), 8)).toBeNull();
    expect(runOf(new Set(), 8)).toBeNull();
    expect(runOf(new Set([0, 1, 2, 3, 4, 5, 6, 7]), 8)).toBeNull();
    expect(runOf(new Set([0, 1, 2, 3, 4, 5, 6]), 8)).toBeNull();
  });

  it('Interpolate between puts the run on a straight line between its two neighbours', () => {
    const out = interpolateRun(base, new Set([2, 3]), drawn);
    if (!out) throw new Error('no run');
    // vertex 1 (z 101) to vertex 4 (offset 0.5 over 204, so 204.5), 6 m along the edge
    expect(out.vertices[2]?.z).toBeCloseTo(101 + (204.5 - 101) / 3, 9);
    expect(out.vertices[3]?.z).toBeCloseTo(101 + ((204.5 - 101) * 2) / 3, 9);
    expect(out.vertices[2]?.offsetM).toBeUndefined();
    // the neighbours and the rest stay as they were
    expect(out.vertices[1]).toEqual(base.vertices[1]);
    expect(out.vertices[4]).toEqual(base.vertices[4]);
    expect(out.vertices[0]).toEqual(base.vertices[0]);
  });

  it('interpolates a run across the ring start by the distance along the edge', () => {
    const out = interpolateRun(base, new Set([7, 0]), drawn);
    if (!out) throw new Error('no run');
    // vertex 6 (z 106) to vertex 1 (z 101): 7 at 2 m of 6, 0 at 4 m of 6
    expect(out.vertices[7]?.z).toBeCloseTo(106 - 5 / 3, 9);
    expect(out.vertices[0]?.z).toBeCloseTo(106 - 10 / 3, 9);
  });

  it('refuses a selection that is not one run', () => {
    expect(interpolateRun(base, new Set([1, 3]), drawn)).toBeNull();
  });
});

describe('preparing surfaces', () => {
  const manifest = {
    captures: [
      { id: 'd1', label: 'Survey 2 March 2026', date: '2026-03-02' },
      { id: 'd2', label: 'Survey 6 April 2026', date: '2026-04-06' },
    ],
    layers: [
      { kind: 'raster', id: 'dsm-d1', role: 'dsm', capture: 'd1', name: 'DSM 1' },
      { kind: 'raster', id: 'ortho-d1', role: 'ortho', capture: 'd1', name: 'Ortho 1' },
      { kind: 'raster', id: 'dsm-d2', role: 'dsm', capture: 'd2', name: 'DSM 2' },
    ],
  } as unknown as Pick<ProjectManifest, 'captures' | 'layers'>;

  it('asks for every capture DSM not prepared yet', () => {
    expect(prepareParams(manifest, [])).toEqual({
      surfaces: [
        {
          id: 'dsm-d1',
          name: 'Survey 2 March 2026 DSM',
          source: { kind: 'dsm', layer: 'dsm-d1' },
          capture: 'd1',
        },
        {
          id: 'dsm-d2',
          name: 'Survey 6 April 2026 DSM',
          source: { kind: 'dsm', layer: 'dsm-d2' },
          capture: 'd2',
        },
      ],
    });
    const done = [{ source: { kind: 'dsm', layer: 'dsm-d1' } }] as unknown as HeightTiles[];
    expect(prepareParams(manifest, done)?.surfaces.map((s) => s.id)).toEqual(['dsm-d2']);
    expect(
      prepareParams(manifest, [
        ...done,
        { source: { kind: 'dsm', layer: 'dsm-d2' } } as unknown as HeightTiles,
      ]),
    ).toBeNull();
  });

  it('prepareParams falls back to the cloud and sets capture', () => {
    const m = {
      captures: [
        ...manifest.captures,
        { id: 'd3', label: 'Survey 4 May 2026', date: '2026-05-04' },
        { id: 'd4', label: 'Survey 1 June 2026', date: '2026-06-01' },
      ],
      layers: [
        ...manifest.layers,
        { kind: 'pointcloud', id: 'pc-d3', capture: 'd3', name: 'Cloud 3' },
        // a date with a DSM and a cloud prepares its DSM only
        { kind: 'pointcloud', id: 'pc-d2', capture: 'd2', name: 'Cloud 2' },
      ],
    } as unknown as Pick<ProjectManifest, 'captures' | 'layers'>;
    const done = [
      { capture: 'd1', source: { kind: 'dsm', layer: 'dsm-d1' } },
    ] as unknown as HeightTiles[];
    expect(prepareParams(m, done)?.surfaces).toEqual([
      {
        id: 'dsm-d2',
        name: 'Survey 6 April 2026 DSM',
        source: { kind: 'dsm', layer: 'dsm-d2' },
        capture: 'd2',
      },
      {
        id: 'pc-d3',
        name: 'Survey 4 May 2026 cloud',
        source: { kind: 'cloud', layer: 'pc-d3' },
        capture: 'd3',
      },
    ]);
    // only the dates asked for
    expect(prepareParams(m, done, ['d3'])?.surfaces.map((s) => s.id)).toEqual(['pc-d3']);
    expect(prepareParams(m, done, ['d1'])).toBeNull();
    // a date whose surface was prepared from its cloud is not prepared again
    const fromCloud = [
      ...done,
      { capture: 'd3', source: { kind: 'cloud', layer: 'pc-d3' } },
    ] as unknown as HeightTiles[];
    expect(prepareParams(m, fromCloud)?.surfaces.map((s) => s.id)).toEqual(['dsm-d2']);
  });
});
