import { describe, expect, it } from 'vitest';
import { lastBlocksMm, num, signed, spreadMarkers, type VolumetricTexts } from './chrome';

describe('volumetric number formats', () => {
  it('keeps the minus on a negative volume', () => {
    expect(num(-200)).toBe('−200');
    expect(num(-42.25)).toBe('−42.3');
    expect(num(1131)).toBe('1,131');
  });

  it('signed does not double the sign', () => {
    expect(signed(-200, ' m³')).toBe('−200 m³');
    expect(signed(5, ' m³')).toBe('+5.0 m³');
  });
});

const dist = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('spreading pile badges that would collide', () => {
  const R = 2.6;

  it('moves two badges at one point at least a diameter apart, each with a leader to that point', () => {
    const [a, b] = spreadMarkers(
      [
        [50, 40],
        [50, 40],
      ],
      R,
    );
    if (!a || !b) throw new Error('two badges');
    expect(dist(a.at, b.at)).toBeGreaterThanOrEqual(2 * R);
    expect(a.anchor).toEqual([50, 40]);
    expect(b.anchor).toEqual([50, 40]);
    expect(a.moved).toBe(true);
    expect(b.moved).toBe(true);
    // each stays near its true place: no further than it has to go
    expect(dist(a.at, a.anchor)).toBeLessThan(2 * R);
    expect(dist(b.at, b.anchor)).toBeLessThan(2 * R);
  });

  it('leaves badges that stand clear exactly where they are', () => {
    const points: [number, number][] = [
      [10, 10],
      [30, 10],
      [10, 30],
    ];
    const out = spreadMarkers(points, R);
    expect(out.map((m) => m.at)).toEqual(points);
    expect(out.every((m) => !m.moved)).toBe(true);
  });

  it('separates a cluster and leaves the far badge alone', () => {
    const out = spreadMarkers(
      [
        [20, 20],
        [21, 20],
        [20.5, 21],
        [80, 60],
      ],
      R,
    );
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) {
        const a = out[i];
        const b = out[j];
        if (!a || !b) throw new Error('badges');
        expect(dist(a.at, b.at)).toBeGreaterThanOrEqual(2 * R);
      }
    expect(out[3]?.at).toEqual([80, 60]);
    expect(out[3]?.moved).toBe(false);
  });

  it('keeps moved badges inside the picture', () => {
    const out = spreadMarkers(
      [
        [1, 1],
        [1, 1],
        [1, 1],
      ],
      R,
      { width: 60, height: 40 },
    );
    for (const m of out) {
      expect(m.at[0]).toBeGreaterThanOrEqual(R);
      expect(m.at[1]).toBeGreaterThanOrEqual(R);
      expect(m.at[0]).toBeLessThanOrEqual(60 - R);
      expect(m.at[1]).toBeLessThanOrEqual(40 - R);
    }
    const [a, b, c] = out;
    if (!a || !b || !c) throw new Error('three badges');
    expect(dist(a.at, b.at)).toBeGreaterThanOrEqual(2 * R);
    expect(dist(a.at, c.at)).toBeGreaterThanOrEqual(2 * R);
    expect(dist(b.at, c.at)).toBeGreaterThanOrEqual(2 * R);
  });

  it('moves a badge off a box it would cover, the shortest way that stays on the picture', () => {
    // the north chip in the top right corner of a 60 by 40 picture
    const chip = { x: 46, y: 2, width: 12, height: 6 };
    const [m, far] = spreadMarkers(
      [
        [50, 6],
        [20, 30],
      ],
      R,
      { width: 60, height: 40 },
      [chip],
    );
    if (!m || !far) throw new Error('two badges');
    // out below the chip (2.6 mm up would leave the picture), with a leader back
    expect(m.at[0]).toBe(50);
    expect(m.at[1]).toBeCloseTo(chip.y + chip.height + R, 6);
    expect(m.moved).toBe(true);
    expect(m.anchor).toEqual([50, 6]);
    expect(far.at).toEqual([20, 30]);
    expect(far.moved).toBe(false);
  });

  it('gives the same result every time', () => {
    const points: [number, number][] = [
      [5, 5],
      [5, 5],
      [6, 5],
    ];
    expect(spreadMarkers(points, R)).toEqual(spreadMarkers(points, R));
  });
});

describe('the closing block of the last page', () => {
  const texts = (over: Partial<VolumetricTexts>): VolumetricTexts => ({
    title: 'Volumetric report',
    preparedFor: null,
    preparedBy: null,
    summary: 'In short.',
    intro: null,
    method: 'Base: Lowest point.',
    closing: null,
    ...over,
  });

  it('takes no room on any page but the last, and more with more text', () => {
    expect(lastBlocksMm(texts({}), false)).toBe(0);
    const short = lastBlocksMm(texts({}), true);
    expect(short).toBeGreaterThan(0);
    expect(lastBlocksMm(texts({ method: 'x'.repeat(400) }), true)).toBeGreaterThan(short);
    expect(lastBlocksMm(texts({ closing: 'Thank you.' }), true)).toBeGreaterThan(short);
    expect(lastBlocksMm(texts({ method: null }), true)).toBe(0);
  });
});
