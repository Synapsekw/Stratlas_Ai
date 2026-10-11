import { describe, expect, it } from 'vitest';
import {
  QUARTER,
  QUARTER_SMALL,
  quarterBounds,
  quarterPieces,
  quarterPolygons,
  quarterSmallPieces,
  ringPolygons,
  ringSection,
  roundSquare,
  sectorPolygon,
} from './quarter';

const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe('the Quarter mark', () => {
  it('has three quarters and a tail, each a closed outline', () => {
    const pieces = quarterPieces();
    expect(pieces).toHaveLength(4);
    for (const d of pieces) expect(d).toMatch(/^M[\d. -]+.*Z$/);
    // the quarters are ring sections (two long arcs), the tail has none
    expect(pieces[0].match(/A23 23/g)).toHaveLength(1);
    expect(pieces[0].match(/A10\.5 10\.5/g)).toHaveLength(1);
    expect(pieces[3]).not.toMatch(/A23 23/);
  });

  it('stays inside its bounds: 4 to 56 on both axes', () => {
    expect(quarterBounds(QUARTER)).toEqual({ x: 4, y: 4, w: 52, h: 52 });
    for (const poly of quarterPolygons())
      for (const [x, y] of poly) {
        expect(x).toBeGreaterThanOrEqual(4 - 1e-9);
        expect(x).toBeLessThanOrEqual(56 + 1e-9);
        expect(y).toBeGreaterThanOrEqual(4 - 1e-9);
        expect(y).toBeLessThanOrEqual(56 + 1e-9);
      }
  });

  it('starts the outer arc of the north-west quarter on the outer circle', () => {
    const [x, y] = numbers(ringSection(27, 27, 10.5, 23, 180, 270, 1.6));
    expect(Math.hypot((x ?? 0) - 27, (y ?? 0) - 27)).toBeCloseTo(23, 1);
  });

  it('rounds the tail with the corner radius', () => {
    expect(roundSquare(35, 35, 21, 1.6)).toBe(
      'M36.6 35H54.4A1.6 1.6 0 0 1 56 36.6V54.4A1.6 1.6 0 0 1 54.4 56H36.6A1.6 1.6 0 0 1 35 54.4V36.6A1.6 1.6 0 0 1 36.6 35Z',
    );
  });

  it('has a small cut of two pieces: one closed ring section and the tail', () => {
    const [ring, tail] = quarterSmallPieces();
    // 270 degrees of ring: both long arcs take the large-arc flag
    expect(ring).toMatch(/A24\.5 24\.5 0 1 1/);
    expect(ring).toMatch(/A8\.5 8\.5 0 1 0/);
    expect(tail).toMatch(/^M37\.2 36H/);
    expect(quarterBounds(QUARTER_SMALL)).toEqual({ x: 4, y: 4, w: 53, h: 53 });
  });

  it('draws polygons clockwise, in piece order, the tail last', () => {
    const polys = quarterPolygons();
    expect(polys).toHaveLength(4);
    expect(polys[3]).toEqual([
      [35, 35],
      [56, 35],
      [56, 56],
      [35, 56],
    ]);
    const area = (p: readonly (readonly [number, number])[]) =>
      p.reduce((a, [x, y], i) => {
        const [nx, ny] = p[(i + 1) % p.length] ?? [0, 0];
        return a + x * ny - nx * y;
      }, 0) / 2;
    for (const p of polys) expect(area(p)).toBeGreaterThan(0);
    expect(sectorPolygon(0, 0, 0, 10, 0, 90, 4)).toHaveLength(6);
  });

  it('closes the ring with a south-east quarter for the Step out motion', () => {
    const ring = ringPolygons();
    expect(ring).toHaveLength(4);
    // the fourth quarter sits south-east of the centre
    for (const [x, y] of ring[3] ?? []) {
      expect(x).toBeGreaterThanOrEqual(31 - 1e-9);
      expect(y).toBeGreaterThanOrEqual(31 - 1e-9);
    }
  });
});
