import type { Alignment } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  alignmentDrawing,
  designPoints,
  drape,
  lineworkLines,
  MAX_TICKS,
  tinOutline,
} from './designsGeometry';

/** Two triangles per cell of an n x n grid of (n + 1)^2 vertices, row by row. */
function grid(n: number, skip: (i: number, j: number) => boolean = () => false): number[] {
  const t: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      if (skip(i, j)) continue;
      const a = j * (n + 1) + i;
      t.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  return t;
}

const edgesOf = (chain: number[]) => chain.length - 1;

describe('design geometry', () => {
  it('outlines a triangulation as one closed loop of its border edges', () => {
    const one = tinOutline([0, 1, 2], 3);
    expect(one).toHaveLength(1);
    expect(one[0]?.[0]).toBe(one[0]?.[3]);
    expect(edgesOf(one[0] ?? [])).toBe(3);

    // the 3 x 3 vertex pad of the e2e design: 8 border edges, the 8 inner ones left out
    const pad = tinOutline(grid(2), 9);
    expect(pad).toHaveLength(1);
    const loop = pad[0] ?? [];
    expect(edgesOf(loop)).toBe(8);
    expect(loop[0]).toBe(loop[loop.length - 1]);
    expect(new Set(loop)).toEqual(new Set([0, 1, 2, 3, 5, 6, 7, 8]));
  });

  it('outlines a void as a second loop', () => {
    // a 3 x 3 grid of cells without the middle one: the outer border and the hole's
    const ring = tinOutline(
      grid(3, (i, j) => i === 1 && j === 1),
      16,
    );
    expect(ring.map(edgesOf).sort((a, b) => a - b)).toEqual([4, 12]);
  });

  it('reads linework lines and points from GeoJSON with Z', () => {
    const json = {
      type: 'FeatureCollection',
      features: [
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [1, 2, 3],
              [4, 5, 6],
            ],
          },
        },
        {
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [0, 0],
                [1, 1],
              ],
              [[9, 9, 9]],
            ],
          },
        },
        {
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0, 1],
                [1, 0, 1],
                [1, 1, 1],
                [0, 0, 1],
              ],
            ],
          },
        },
        { geometry: null },
        { geometry: { type: 'Point', coordinates: [7, 8, 9] }, properties: { id: 'CP1' } },
        { geometry: { type: 'Point', coordinates: [1, 1] } },
      ],
    };
    const lines = lineworkLines(json);
    // the one-vertex line is left out; a missing Z is 0
    expect(lines.map((l) => l.length)).toEqual([2, 2, 4]);
    expect(lines[1]?.[0]).toEqual([0, 0, 0]);
    expect(designPoints(json)).toEqual([
      { p: [7, 8, 9], id: 'CP1' },
      { p: [1, 1, 0], id: '2' },
    ]);
    expect(lineworkLines(null)).toEqual([]);
  });

  const straight: Alignment = {
    schema: 'aio.alignment/1',
    name: 'CL',
    crs: { epsg: 32640 },
    startStation: 1000,
    elements: [{ type: 'line', start: [500, 0], end: [500, 100], length: 100 }],
    equations: [],
  };

  it('ticks an alignment at every station interval, across the line, with its station', () => {
    const d = alignmentDrawing(straight, { intervalM: 20, tickM: 4 });
    expect(d.line[0]).toEqual([500, 0]);
    expect(d.line[d.line.length - 1]).toEqual([500, 100]);
    expect(d.ticks.map((t) => t.label)).toEqual([
      '1+000',
      '1+020',
      '1+040',
      '1+060',
      '1+080',
      '1+100',
    ]);
    // heading north: the tick runs west to east, the label on the right (east) end
    const t = d.ticks[1];
    expect(t?.a[0]).toBeCloseTo(498);
    expect(t?.a[1]).toBeCloseTo(20);
    expect(t?.b[0]).toBeCloseTo(502);
    expect(t?.at).toEqual(t?.b);
    // the file's interval when the layer sets none, else 20 m
    expect(alignmentDrawing({ ...straight, intervalM: 50 }).ticks).toHaveLength(3);
    expect(alignmentDrawing(straight).ticks).toHaveLength(6);
  });

  it('thins the ticks of a very long alignment', () => {
    const long: Alignment = {
      ...straight,
      elements: [{ type: 'line', start: [0, 0], end: [0, 100000], length: 100000 }],
    };
    const d = alignmentDrawing(long, { intervalM: 1 });
    expect(d.ticks.length).toBeLessThanOrEqual(MAX_TICKS + 1);
    expect(d.ticks.length).toBeGreaterThan(MAX_TICKS / 2);
  });

  it('drapes horizontal geometry on the terrain, else at a fallback height', () => {
    const at = (e: number) => (e > 0 ? 7 : null);
    expect(
      drape(
        [
          [1, 2],
          [-1, 2],
        ],
        at,
        3,
      ),
    ).toEqual([
      [1, 2, 7],
      [-1, 2, 3],
    ]);
    expect(drape([[1, 2]], null, 3)).toEqual([[1, 2, 3]]);
  });
});
