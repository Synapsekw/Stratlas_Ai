import type { SitePoint } from '@aio/schema';
import type { ToScreen } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import { distanceToSegment, insideRing, measureAt, type HitShape } from './measureHits';

const id2d: ToScreen = (p) => ({ x: p[0], y: p[1] });

const line = (id: string, a: [number, number], b: [number, number]): HitShape => ({
  id,
  points: [
    [a[0], a[1], 0],
    [b[0], b[1], 0],
  ],
  closed: false,
});

const square = (id: string, lo: number, hi: number): HitShape => ({
  id,
  points: [
    [lo, lo, 0],
    [hi, lo, 0],
    [hi, hi, 0],
    [lo, hi, 0],
  ] as SitePoint[],
  closed: true,
});

describe('measureAt', () => {
  it('hits a segment within 6 px and not at 7 px', () => {
    const l = line('l', [0, 0], [100, 0]);
    expect(measureAt([l], id2d, 50, 6)).toBe('l');
    expect(measureAt([l], id2d, 50, 7)).toBeNull();
  });

  it('hits a vertex and an open line past its end within the tolerance only', () => {
    const l = line('l', [0, 0], [100, 0]);
    expect(measureAt([l], id2d, 104, 0)).toBe('l');
    expect(measureAt([l], id2d, 107, 0)).toBeNull();
    const spot: HitShape = { id: 's', points: [[10, 10, 0]], closed: false };
    expect(measureAt([spot], id2d, 13, 14)).toBe('s');
  });

  it('the nearest edge wins, the later shape on a tie', () => {
    const a = line('a', [0, 0], [100, 0]);
    const b = line('b', [0, 4], [100, 4]);
    expect(measureAt([a, b], id2d, 50, 1)).toBe('a');
    expect(measureAt([a, b], id2d, 50, 3)).toBe('b');
    expect(measureAt([a, b], id2d, 50, 2)).toBe('b');
  });

  it('a click inside a polygon picks it; the smaller of two nested polygons wins', () => {
    const big = square('big', 0, 100);
    const small = square('small', 40, 60);
    expect(measureAt([big, small], id2d, 50, 50)).toBe('small');
    expect(measureAt([small, big], id2d, 50, 50)).toBe('small');
    expect(measureAt([big, small], id2d, 20, 20)).toBe('big');
    expect(measureAt([big, small], id2d, 150, 150)).toBeNull();
  });

  it('an edge near the cursor beats a polygon around it', () => {
    const big = square('big', 0, 100);
    const l = line('l', [10, 50], [90, 50]);
    expect(measureAt([l, big], id2d, 50, 52)).toBe('l');
  });

  it('an open line of three points does not close or fill', () => {
    const open: HitShape = { ...square('o', 0, 100), closed: false };
    // the missing closing edge x = 0
    expect(measureAt([open], id2d, 0, 50)).toBeNull();
    expect(measureAt([open], id2d, 50, 50)).toBeNull();
  });

  it('points behind the camera are skipped', () => {
    const behind: ToScreen = (p) => (p[0] < 0 ? null : { x: p[0], y: p[1] });
    const l = line('l', [-20, 0], [20, 0]);
    expect(measureAt([l], behind, 5, 0)).toBeNull();
    // the end in front is still a vertex
    expect(measureAt([l], behind, 18, 3)).toBe('l');
    // a closed ring with a point behind fills nothing
    const sq: HitShape = { ...square('sq', -50, 50) };
    expect(measureAt([sq], behind, 20, 20)).toBeNull();
  });

  it('handles 500 shapes', () => {
    const fiveHundredLines = Array.from({ length: 500 }, (_, i) =>
      line(`m${String(i)}`, [0, i * 20], [100, i * 20]),
    );
    expect(measureAt(fiveHundredLines, id2d, 1, 1)).toBe('m0');
    expect(measureAt(fiveHundredLines, id2d, 50, 9981)).toBe('m499');
  });
});

describe('geometry', () => {
  it('distanceToSegment clamps to the ends and handles a zero length', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distanceToSegment({ x: 5, y: 3 }, a, b)).toBe(3);
    expect(distanceToSegment({ x: 13, y: 4 }, a, b)).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, a, a)).toBe(5);
  });

  it('insideRing casts an even-odd ray', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(insideRing({ x: 5, y: 5 }, ring)).toBe(true);
    expect(insideRing({ x: 15, y: 5 }, ring)).toBe(false);
  });
});
