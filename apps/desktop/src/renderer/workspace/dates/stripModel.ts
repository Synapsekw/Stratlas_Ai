import { formatCompact } from '@aio/ui';

/**
 * The dates strip's geometry: a true-time x scale, month gridlines, survey snapping, the stacked
 * volume or tonnes areas and the cut and fill bars. Dates are epoch ms; undated captures are never
 * placed on the strip. Nothing here estimates a figure between surveys: the areas are straight lines
 * between survey points, drawn by the component.
 */

const DAY_MS = 86_400_000;
/** One survey alone shows this window, centred on it. */
const SINGLE_WINDOW_MS = 30 * DAY_MS;

export type StripMode = 'volume' | 'tonnes' | 'cutFill';

export interface StripScale {
  /** Pixel from the left edge for a time. */
  x(t: number): number;
  /** Time for a pixel from the left edge. */
  t(x: number): number;
  t0: number;
  t1: number;
}

const finite = (dates: readonly number[]): number[] =>
  dates.filter((d) => Number.isFinite(d)).sort((a, b) => a - b);

/** A linear time scale over `widthPx`, padded `pad` of the span each side (default 4 %). */
export function stripScale(dates: readonly number[], widthPx: number, pad = 0.04): StripScale {
  const ds = finite(dates);
  const first = ds[0];
  const last = ds[ds.length - 1];
  let t0: number;
  let t1: number;
  if (first === undefined || last === undefined) {
    t0 = -SINGLE_WINDOW_MS / 2;
    t1 = SINGLE_WINDOW_MS / 2;
  } else if (last === first) {
    t0 = first - SINGLE_WINDOW_MS / 2;
    t1 = first + SINGLE_WINDOW_MS / 2;
  } else {
    const span = last - first;
    t0 = first - span * pad;
    t1 = last + span * pad;
  }
  const w = Number.isFinite(widthPx) && widthPx > 0 ? widthPx : 1;
  const span = t1 - t0;
  return {
    t0,
    t1,
    x: (t) => ((t - t0) / span) * w,
    t: (x) => t0 + (x / w) * span,
  };
}

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** The first of each month in [t0, t1] (UTC), labelled "Dec 2020". */
export function monthTicks(t0: number, t1: number): { t: number; label: string }[] {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return [];
  const start = new Date(t0);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  if (Date.UTC(y, m, 1) < t0) m += 1;
  const out: { t: number; label: string }[] = [];
  // a strip never spans centuries; the cap keeps a bad range from hanging the renderer
  for (let i = 0; i < 2400; i += 1) {
    const t = Date.UTC(y, m, 1);
    if (t > t1) break;
    out.push({ t, label: MONTH_LABEL.format(t) });
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

/** The survey nearest `t`; `t` itself when there is none. */
export function snapToSurvey(t: number, dates: readonly number[]): number {
  let best = t;
  let gap = Infinity;
  for (const d of dates) {
    if (!Number.isFinite(d)) continue;
    const g = Math.abs(d - t);
    if (g < gap) {
      gap = g;
      best = d;
    }
  }
  return best;
}

/** One material's figure on a survey date (C2 `MaterialGroup`, reduced to what the strip draws). */
export interface StripGroup {
  /** The material id, '' for "No material". */
  key: string;
  colour: string;
  volumeM3: number;
  /** Null without a density: it adds nothing to the Tonnes stack. */
  tonnes: number | null;
}

/** A survey with its figures by material; `t` null for an undated capture (skipped). */
export interface StripDate {
  capture: string;
  t: number | null;
  groups: readonly StripGroup[];
}

export interface StackPoint {
  capture: string;
  t: number;
  y0: number;
  y1: number;
}

export interface StackLayer {
  key: string;
  colour: string;
  points: StackPoint[];
}

export interface StackSeries {
  /** Bottom to top, in the order the materials first appear, "No material" ('') on top. */
  layers: StackLayer[];
  /** The stacked total per survey, in date order. */
  totals: { capture: string; t: number; value: number }[];
  max: number;
}

/** Volume or Tonnes stacked by material, one point per dated survey in date order. */
export function stackSeries(dates: readonly StripDate[], mode: StripMode): StackSeries {
  if (mode === 'cutFill') return { layers: [], totals: [], max: 0 };
  const dated = dates
    .filter((d): d is StripDate & { t: number } => d.t !== null && Number.isFinite(d.t))
    .sort((a, b) => a.t - b.t);
  const order: { key: string; colour: string }[] = [];
  for (const d of dated) {
    for (const g of d.groups) {
      if (!order.some((o) => o.key === g.key)) order.push({ key: g.key, colour: g.colour });
    }
  }
  // "No material" stacks on top, as it comes last in the inventory
  order.sort((a, b) => Number(a.key === '') - Number(b.key === ''));
  const layers: StackLayer[] = order.map((o) => ({ ...o, points: [] }));
  const totals: StackSeries['totals'] = [];
  let max = 0;
  for (const d of dated) {
    let y = 0;
    order.forEach((o, i) => {
      const g = d.groups.find((x) => x.key === o.key);
      const raw = g ? (mode === 'volume' ? g.volumeM3 : (g.tonnes ?? 0)) : 0;
      const v = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      layers[i]?.points.push({ capture: d.capture, t: d.t, y0: y, y1: y + v });
      y += v;
    });
    totals.push({ capture: d.capture, t: d.t, value: y });
    max = Math.max(max, y);
  }
  return { layers, totals, max };
}

export interface CutFillPair {
  from: string;
  to: string;
  cutM3: number;
  fillM3: number;
}

export interface CutFillBar extends CutFillPair {
  netM3: number;
  /** Pixel extent of the bar, inset inside the gap between the two surveys. */
  x0: number;
  x1: number;
}

/** Share of the gap a bar leaves empty on each side. */
const BAR_INSET = 0.2;

/**
 * Diverging bars between consecutive surveys: fill up, cut down (the component draws them from
 * `fillM3` and `cutM3`). A pair with an undated capture is skipped.
 */
export function cutFillBars(
  pairs: readonly CutFillPair[],
  scale: StripScale,
  timeOf: (capture: string) => number | null,
): CutFillBar[] {
  const out: CutFillBar[] = [];
  for (const p of pairs) {
    const a = timeOf(p.from);
    const b = timeOf(p.to);
    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const xa = scale.x(Math.min(a, b));
    const xb = scale.x(Math.max(a, b));
    const inset = (xb - xa) * BAR_INSET;
    out.push({ ...p, netM3: p.fillM3 - p.cutM3, x0: xa + inset, x1: xb - inset });
  }
  return out;
}

const NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Three ticks from zero, the top one at or above `max` on a round step ("0", "40k", "80k"). */
export function yTicks(max: number): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1, 2];
  const half = max / 2;
  const mag = 10 ** Math.floor(Math.log10(half));
  const unit = NICE.find((n) => n * mag >= half - 1e-9 * mag) ?? 10;
  const step = unit * mag;
  return [0, step, step * 2];
}

/** "80k", "1.5M": the compact number without its space. */
export function yTickLabel(v: number): string {
  return formatCompact(v).replace(' ', '');
}
