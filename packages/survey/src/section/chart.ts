// The profile chart's pure model: how each series is drawn by kind, what can be shaded against,
// and the hover readout. No drawing here; the chart component reads these.
import { gradeOf, type Grade } from './profile';

export type SeriesKind = 'current' | 'earlier' | 'design' | 'base';

export interface ChartSeries {
  key: string;
  label: string;
  kind: SeriesKind;
  capture?: string;
  date?: string;
  chainage: readonly number[];
  z: readonly (number | null)[];
}

export interface SeriesStyle {
  stroke: string;
  dash: '' | '6 4' | '1 3';
  width: number;
  opacity: number;
}

const NEWEST_OPACITY = 0.9;
const OLDEST_OPACITY = 0.35;

/** Oldest first; undated series sort by key so the order never depends on how they were added. */
function byAge(a: ChartSeries, b: ChartSeries): number {
  const da = a.date ?? '';
  const db = b.date ?? '';
  if (da !== db) return da < db ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function seriesStyle(s: ChartSeries, all: readonly ChartSeries[]): SeriesStyle {
  switch (s.kind) {
    case 'current':
      return { stroke: 'var(--chart-current)', dash: '', width: 2, opacity: 1 };
    case 'design':
      return { stroke: 'var(--chart-design)', dash: '6 4', width: 1.5, opacity: 1 };
    case 'base':
      return { stroke: 'var(--chart-base)', dash: '1 3', width: 1.5, opacity: 1 };
    case 'earlier': {
      const earlier = all.filter((x) => x.kind === 'earlier').sort(byAge);
      const rank = Math.max(
        0,
        earlier.findIndex((x) => x.key === s.key),
      );
      const last = earlier.length - 1;
      // Newest earlier date 0.9, stepping linearly down to 0.35 for the oldest. The rank is
      // within 0..last, so the value cannot leave that range and needs no clamp.
      const opacity =
        last <= 0
          ? NEWEST_OPACITY
          : OLDEST_OPACITY + ((NEWEST_OPACITY - OLDEST_OPACITY) * rank) / last;
      return { stroke: 'var(--chart-earlier)', dash: '', width: 1.5, opacity };
    }
  }
}

const DRAW_RANK: Record<SeriesKind, number> = { base: 0, design: 1, earlier: 2, current: 3 };

/** Base, designs, earlier dates oldest first, current last, so the current line draws on top. */
export function orderSeries(all: readonly ChartSeries[]): ChartSeries[] {
  return [...all].sort((a, b) => DRAW_RANK[a.kind] - DRAW_RANK[b.kind] || byAge(a, b));
}

export function shadeTargets(visible: readonly ChartSeries[]): { key: string; label: string }[] {
  return visible.filter((s) => s.kind !== 'current').map((s) => ({ key: s.key, label: s.label }));
}

export interface HoverRow {
  key: string;
  label: string;
  z: number | null;
}

export interface HoverReadout {
  chainage: number;
  rows: HoverRow[];
  deltaM: number | null;
  grade: Grade | null;
}

/** The segment [i, i+1] holding `at`, or null when `at` is outside the samples. */
function segmentAt(s: ChartSeries, at: number): number | null {
  const n = Math.min(s.chainage.length, s.z.length);
  const first = s.chainage[0];
  const end = s.chainage[n - 1];
  if (n < 2 || first === undefined || end === undefined) return null;
  if (at < first || at > end) return null;
  for (let i = 0; i < n - 1; i++) if (at <= (s.chainage[i + 1] ?? Infinity)) return i;
  return null;
}

function zAt(s: ChartSeries, at: number): number | null {
  const i = segmentAt(s, at);
  if (i === null) return null;
  const z0 = s.z[i];
  const z1 = s.z[i + 1];
  if (z0 == null || z1 == null) return null;
  const c0 = s.chainage[i] ?? 0;
  const c1 = s.chainage[i + 1] ?? 0;
  if (c1 === c0) return z0;
  return z0 + ((z1 - z0) * (at - c0)) / (c1 - c0);
}

function gradeAt(s: ChartSeries, at: number): Grade | null {
  const i = segmentAt(s, at);
  if (i === null) return null;
  const z0 = s.z[i];
  const z1 = s.z[i + 1];
  if (z0 == null || z1 == null) return null;
  const run = (s.chainage[i + 1] ?? 0) - (s.chainage[i] ?? 0);
  return run > 0 ? gradeOf(z1 - z0, run) : null;
}

export function hoverAt(
  visible: readonly ChartSeries[],
  chainage: number,
  target: string | null,
): HoverReadout {
  const rows: HoverRow[] = visible.map((s) => ({
    key: s.key,
    label: s.label,
    z: zAt(s, chainage),
  }));
  const current = visible.find((s) => s.kind === 'current');
  const cz = current ? zAt(current, chainage) : null;
  const tz = target === null ? null : (rows.find((r) => r.key === target)?.z ?? null);
  return {
    chainage,
    rows,
    deltaM: cz !== null && tz !== null ? cz - tz : null,
    grade: current ? gradeAt(current, chainage) : null,
  };
}

/** The lowest and highest elevation across the visible series, or null when none has data. */
export function zExtent(visible: readonly ChartSeries[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of visible)
    for (const v of s.z)
      if (v != null && Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
  return lo > hi ? null : [lo, hi];
}
