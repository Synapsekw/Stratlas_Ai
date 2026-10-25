/**
 * Bug 1 (volumetric report): a pile's figure per survey date must be worked out inside that
 * date's own outline. A pile moved and shrunk between two surveys, measured inside the latest
 * outline on both dates, loses its first-date volume (the pile was elsewhere then), so the change
 * comes out wrong. `seriesRequests` runs each date on its own outline.
 */
import type { ComparisonItem, SitePoint, SurfaceRef, SurveyMeasurement } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { seriesRequests } from '../calc/outlines';
import type { Resolve, ResolvedSurface } from './compare';
import { compareSeries } from './series';
import { ArraySurface } from './tiles';

const E0 = 302000;
const N0 = 2574000;
const EXTENT = 60;
const CELL = 0.25;

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

/** A cone of `height` and `radius` on flat ground at 100 m, centred at (cx, cy) in grid metres. */
const cone =
  (cx: number, cy: number, height: number, radius: number): Shape =>
  (x, y) =>
    100 + Math.max(0, height * (1 - Math.hypot(x - cx, y - cy) / radius));
const coneVolume = (height: number, radius: number) => (Math.PI * radius * radius * height) / 3;

// Date 1: a 4 m cone of radius 8 at A; date 2: moved to B and shrunk to 3 m, radius 6.
const A = { cx: 15, cy: 15, h: 4, r: 8 };
const B = { cx: 42, cy: 40, h: 3, r: 6 };
const DATES: Record<string, ResolvedSurface> = {
  c1: gridOf(cone(A.cx, A.cy, A.h, A.r), 'Survey 1'),
  c2: gridOf(cone(B.cx, B.cy, B.h, B.r), 'Survey 2'),
};
const CAPTURES = ['c1', 'c2'];

const resolveAt =
  (capture: string): Resolve =>
  (ref: SurfaceRef) => {
    const s = DATES[capture];
    if (ref.kind === 'current' && s) return Promise.resolve({ ...s, capture });
    return Promise.reject(new Error(`${ref.kind} is not a surface here`));
  };

/** A circle around a pile, a metre and a half past its toe, in the project CRS. */
const around = (p: { cx: number; cy: number; r: number }): SitePoint[] =>
  Array.from({ length: 64 }, (_, k): SitePoint => [
    E0 + p.cx + (p.r + 1.5) * Math.cos((2 * Math.PI * k) / 64),
    N0 + p.cy + (p.r + 1.5) * Math.sin((2 * Math.PI * k) / 64),
    100,
  ]);

const item: ComparisonItem = {
  id: 'i',
  from: { kind: 'smart' },
  to: { kind: 'current' },
  useDeadband: false,
};
const opts = { now: () => '2026-10-25T00:00:00Z' };

const pile: SurveyMeasurement = {
  id: 'm',
  family: 'polygon',
  tool: 'volume',
  label: 'Pile',
  scope: { kind: 'site' },
  points: around(B),
  outlines: [
    { capture: 'c1', points: around(A) },
    { capture: 'c2', points: around(B) },
  ],
  items: [item],
  results: [],
  createdAt: '2026-10-25T00:00:00Z',
};

function within1pct(got: number | undefined, want: number): void {
  expect(Math.abs((got ?? NaN) - want) / want).toBeLessThan(0.01);
}

describe('a series per survey date, each on its own outline', () => {
  it('the latest outline on both dates loses the first date (the bug)', async () => {
    const rs = await compareSeries(pile.points, item, resolveAt, CAPTURES, opts);
    // the pile stood at A on date 1, outside the latest outline at B
    expect(rs[0]?.netM3 ?? NaN).toBeLessThan(1);
    within1pct(rs[1]?.netM3, coneVolume(B.h, B.r));
  });

  it("each date's own outline gives both volumes within 1 %", async () => {
    const reqs = seriesRequests(pile, CAPTURES);
    expect(reqs.map((r) => r.captures)).toEqual([['c1'], ['c2']]);
    const byCapture = new Map<string, number>();
    for (const r of reqs) {
      const rs = await compareSeries(r.ring, item, resolveAt, r.captures, opts);
      for (const x of rs) if (x.toCapture) byCapture.set(x.toCapture, x.netM3);
    }
    within1pct(byCapture.get('c1'), coneVolume(A.h, A.r));
    within1pct(byCapture.get('c2'), coneVolume(B.h, B.r));
  });
});
