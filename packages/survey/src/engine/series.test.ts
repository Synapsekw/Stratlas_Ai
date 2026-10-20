/**
 * Volume per survey date and the spread across bases (W3, W4) on in-memory grids, the way
 * `quality.test.ts` builds them. The Python core agrees through `series.parity.test.ts`.
 */
import type { ComparisonItem, SurfaceRef } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Resolve, ResolvedSurface } from './compare';
import { baseSpread, compareSeries, seriesApplies, SPREAD_BASES, spreadPct } from './series';
import { ArraySurface } from './tiles';

const E0 = 302000;
const N0 = 2574000;
const EXTENT = 30;
const CELL = 0.5;

type Shape = (x: number, y: number) => number;

function gridOf(fn: Shape, name: string): ResolvedSurface {
  const n = Math.round(EXTENT / CELL);
  const h = new Float64Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) h[j * n + i] = fn((i + 0.5) * CELL, (j + 0.5) * CELL);
  return {
    kind: 'grid',
    name,
    fingerprint: `fp-${name}`,
    grid: new ArraySurface(E0, N0, CELL, n, n, h),
  };
}

const cone =
  (height: number): Shape =>
  (x, y) =>
    100 + Math.max(0, height * (1 - Math.hypot(x - 15, y - 15) / 10));

/** Three survey dates, each with a cone a metre taller than the last. */
const DATES: Record<string, ResolvedSurface> = {
  c1: gridOf(cone(2), 'Survey 1'),
  c2: gridOf(cone(3), 'Survey 2'),
  c3: gridOf(cone(4), 'Survey 3'),
};
const CAPTURES = ['c1', 'c2', 'c3'];
const DESIGN = gridOf(() => 101, 'Design level');

/** The project's surfaces viewed on `capture` (`projectResolver`'s rules, in memory). */
function resolveAt(capture: string): Resolve {
  return (ref: SurfaceRef) => {
    const at = (c: string | undefined, kind: string): Promise<ResolvedSurface> => {
      const s = c === undefined ? undefined : DATES[c];
      if (!s || c === undefined)
        return Promise.reject(new Error(`There is no ${kind} survey with a prepared surface.`));
      return Promise.resolve({ ...s, capture: c });
    };
    const k = CAPTURES.indexOf(capture);
    switch (ref.kind) {
      case 'current':
        return at(capture, 'current');
      case 'previous':
        return at(k > 0 ? CAPTURES[k - 1] : undefined, 'previous');
      case 'survey':
        return at(ref.capture ?? ref.surface, 'survey');
      case 'design':
        return Promise.resolve(DESIGN);
      default:
        return Promise.reject(new Error(`${ref.kind} is not a surface`));
    }
  };
}

const ring: [number, number][] = Array.from({ length: 64 }, (_, k) => [
  E0 + 15 + 12 * Math.cos((2 * Math.PI * k) / 64),
  N0 + 15 + 12 * Math.sin((2 * Math.PI * k) / 64),
]);
const opts = { now: () => '2026-10-20T00:00:00Z' };
const coneVolume = (h: number) => (Math.PI * 100 * h) / 3;

function item(from: SurfaceRef, to: SurfaceRef): ComparisonItem {
  return { id: 'a', from, to, useDeadband: false };
}

describe('compareSeries', () => {
  it('one result per capture in order, toCapture set', async () => {
    const rs = await compareSeries(
      ring,
      item({ kind: 'smart' }, { kind: 'current' }),
      resolveAt,
      CAPTURES,
      opts,
    );
    expect(rs.map((r) => r.toCapture)).toEqual(CAPTURES);
    expect(rs.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
    rs.forEach((r, k) => {
      expect(r.netM3).toBeCloseTo(coneVolume(k + 2), 0);
    });
  });

  it("previous follows the date: the first date's previous is refused with its reason", async () => {
    const rs = await compareSeries(
      ring,
      item({ kind: 'previous' }, { kind: 'current' }),
      resolveAt,
      CAPTURES,
      opts,
    );
    expect(rs[0]?.status).toBe('refused');
    expect(rs[0]?.reason).toBe('There is no previous survey with a prepared surface.');
    expect(rs.map((r) => r.toCapture)).toEqual(CAPTURES);
    expect(rs.slice(1).map((r) => r.fromCapture)).toEqual(['c1', 'c2']);
    // each date adds a metre to the cone
    expect(rs[1]?.netM3).toBeCloseTo(coneVolume(1), 0);
    expect(rs[2]?.netM3).toBeCloseTo(coneVolume(1), 0);
  });

  it('a fixed design side stays fixed', async () => {
    const rs = await compareSeries(
      ring,
      item({ kind: 'design', design: 'd', layer: 'l' }, { kind: 'current' }),
      resolveAt,
      CAPTURES,
      opts,
    );
    expect(new Set(rs.map((r) => r.fromLabel))).toEqual(new Set(['Design level']));
    expect(rs.map((r) => r.fromCapture)).toEqual([undefined, undefined, undefined]);
    expect(rs.map((r) => r.toCapture)).toEqual(CAPTURES);
    // a higher cone each date: more fill above the fixed level
    const fills = rs.map((r) => r.fillM3);
    expect(fills[0]).toBeLessThan(fills[1] ?? 0);
    expect(fills[1]).toBeLessThan(fills[2] ?? 0);
  });

  it('seriesApplies is false for survey-to-design with fixed captures', () => {
    expect(
      seriesApplies(
        item(
          { kind: 'survey', surface: 's', capture: 'c1' },
          { kind: 'design', design: 'd', layer: 'l' },
        ),
      ),
    ).toBe(false);
    expect(seriesApplies(item({ kind: 'smart' }, { kind: 'current' }))).toBe(true);
    expect(seriesApplies(item({ kind: 'previous' }, { kind: 'current' }))).toBe(true);
    // a previous side alone: its rows would not carry the viewing date
    expect(
      seriesApplies(item({ kind: 'previous' }, { kind: 'design', design: 'd', layer: 'l' })),
    ).toBe(false);
  });
});

describe('baseSpread', () => {
  it('baseSpread is null for a surface-to-surface item', async () => {
    const s = await baseSpread(
      ring,
      item({ kind: 'survey', surface: 'c1' }, { kind: 'current' }),
      resolveAt('c3'),
      opts,
    );
    expect(s).toBeNull();
  });

  it('is (max - min) / 2 / mean of the total volumes over the spread bases, in percent', async () => {
    const s = await baseSpread(ring, item({ kind: 'smart' }, { kind: 'current' }), resolveAt('c3'));
    expect(s).not.toBeNull();
    expect(s?.nets.map((n) => n.base)).toEqual([
      'smart',
      'fit-plane',
      'perimeter-mean',
      'perimeter-min',
    ]);
    expect(SPREAD_BASES).toHaveLength(4);
    // a cone on flat ground: every base is the floor, so the bases agree
    expect(s?.pct).toBeGreaterThanOrEqual(0);
    expect(s?.pct).toBeLessThan(0.5);
  });

  it('gives the hand-computed spread on a tilted plane', async () => {
    // z = 100 + 0.1 x over the square 5..25 m: smart and the best-fit plane are the ground (0 m³),
    // the mean perimeter level (z at x = 15) gives 100 m³ fill + 100 m³ cut = 200 m³, the lowest
    // perimeter point (x = 5) gives 0.1 * 20 * 20² / 2 = 400 m³ fill. Mean 150 m³, so
    // (400 - 0) / 2 / 150 = 133.33 %.
    const plane = gridOf((x) => 100 + 0.1 * x, 'Plane');
    const at: Resolve = (ref) =>
      ref.kind === 'current' ? Promise.resolve(plane) : Promise.reject(new Error('no'));
    const square: [number, number][] = [
      [E0 + 5, N0 + 5],
      [E0 + 25, N0 + 5],
      [E0 + 25, N0 + 25],
      [E0 + 5, N0 + 25],
    ];
    const s = await baseSpread(square, item({ kind: 'smart' }, { kind: 'current' }), at, opts);
    expect(s?.pct).toBeCloseTo(400 / 3, 6);
    const nets = Object.fromEntries((s?.nets ?? []).map((n) => [n.base, n.netM3]));
    expect(nets.smart).toBeCloseTo(0, 6);
    expect(nets['fit-plane']).toBeCloseTo(0, 6);
    expect(nets['perimeter-mean']).toBeCloseTo(0, 6);
    expect(nets['perimeter-min']).toBeCloseTo(400, 6);
  });

  it('spreadPct: one total gives none, and (max - min) / 2 / mean by hand', () => {
    expect(spreadPct([120])).toBeNull();
    expect(spreadPct([])).toBeNull();
    expect(spreadPct([100, 200, 300])).toBe(50);
    expect(spreadPct([0, 1e-7])).toBeNull();
  });

  it('is null when the total is zero', async () => {
    const flatAt: Resolve = (ref) =>
      ref.kind === 'current'
        ? Promise.resolve(gridOf(() => 100, 'Flat'))
        : Promise.reject(new Error('no'));
    expect(
      await baseSpread(ring, item({ kind: 'smart' }, { kind: 'current' }), flatAt, opts),
    ).toBeNull();
  });
});
