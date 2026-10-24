/**
 * The pile panel's state and its pure figures (volumetrics redesign, spec section 3): which tab is
 * open, each pile's profile line (kept for the session, per pile; the scene's A, B and ↻ handles
 * write it), the History unit, and the small sums the panel shows (where a pile sits in the
 * inventory's order, the latest figure and the change since the date before, the largest drop
 * along the profile, the footprint and the kit figure a standard-base figure replaced).
 */
import type { PreviousResult, SitePoint, SurveyMeasurement } from '@aio/schema';
import { seriesDate, type ChartSeries, type PileAxis, type TimeRow } from '@aio/survey';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type PileTab = 'overview' | 'profile' | 'history';
export type HistoryUnit = 'm3' | 't' | 'both';

export interface PileViewState {
  tab: PileTab;
  /** Each pile's profile line, by measurement id; absent: its long axis. */
  axis: ReadonlyMap<string, PileAxis>;
  historyUnit: HistoryUnit;
  setAxis: (id: string, axis: PileAxis) => void;
  setTab: (tab: PileTab) => void;
  setHistoryUnit: (u: HistoryUnit) => void;
}

export function createPileView(): StoreApi<PileViewState> {
  return createStore<PileViewState>()((set) => ({
    tab: 'overview',
    axis: new Map(),
    historyUnit: 'm3',
    setAxis: (id, axis) => {
      set((s) => ({ axis: new Map(s.axis).set(id, axis) }));
    },
    setTab: (tab) => {
      set({ tab });
    },
    setHistoryUnit: (historyUnit) => {
      set({ historyUnit });
    },
  }));
}

export const pileView: StoreApi<PileViewState> = createPileView();

export function usePileView<T>(select: (s: PileViewState) => T): T {
  return useStore(pileView, select);
}

/** Where a pile sits in the inventory's order ("Pile 2 of 19") and its neighbours; null if absent. */
export function pilePosition(
  order: readonly string[],
  id: string,
): { n: number; total: number; prev: string | null; next: string | null } | null {
  const i = order.indexOf(id);
  if (i < 0) return null;
  return {
    n: i + 1,
    total: order.length,
    prev: order[i - 1] ?? null,
    next: order[i + 1] ?? null,
  };
}

export interface PileFigures {
  /** The latest date with a figure. */
  current: TimeRow | null;
  /** The date with a figure before it. */
  previous: TimeRow | null;
  changeM3: number | null;
  /** The change as a percentage of the earlier figure; null from a zero figure. */
  changePct: number | null;
}

/** The latest figure and the change since the date before it that has one (never estimated). */
export function pileFigures(rows: readonly TimeRow[]): PileFigures {
  const withValue = rows.filter((r) => r.valueM3 !== null);
  const current = withValue.at(-1) ?? null;
  const previous = withValue.at(-2) ?? null;
  const now = current?.valueM3 ?? null;
  const before = previous?.valueM3 ?? null;
  const changeM3 = now !== null && before !== null ? now - before : null;
  const changePct =
    changeM3 !== null && before !== null && before !== 0
      ? (changeM3 / Math.abs(before)) * 100
      : null;
  return { current, previous, changeM3, changePct };
}

/** The deepest fall of `later` under `earlier` along the line (metres, negative), or null. */
export function largestDrop(
  later: ChartSeries,
  earlier: ChartSeries,
): { dz: number; chainageM: number } | null {
  let best: { dz: number; chainageM: number } | null = null;
  const n = Math.min(later.chainage.length, later.z.length);
  for (let i = 0; i < n; i++) {
    const c = later.chainage[i];
    const z = later.z[i];
    if (c === undefined || z == null || !Number.isFinite(z)) continue;
    const j = earlier.chainage.indexOf(c);
    const e = j >= 0 ? earlier.z[j] : interpolate(earlier, c);
    if (e == null || !Number.isFinite(e)) continue;
    const dz = z - e;
    if (dz < 0 && (!best || dz < best.dz)) best = { dz, chainageM: c };
  }
  return best;
}

/** A series' height at a chainage, linear between its stations; null outside or over a gap. */
function interpolate(s: ChartSeries, c: number): number | null {
  for (let i = 1; i < s.chainage.length; i++) {
    const c0 = s.chainage[i - 1];
    const c1 = s.chainage[i];
    if (c0 === undefined || c1 === undefined || c < c0 || c > c1) continue;
    const z0 = s.z[i - 1];
    const z1 = s.z[i];
    if (z0 == null || z1 == null) return null;
    return c1 > c0 ? z0 + ((z1 - z0) * (c - c0)) / (c1 - c0) : z0;
  }
  return null;
}

/** The plan area of a ring, square metres (0 below three points). */
export function footprintM2(ring: readonly SitePoint[]): number {
  if (ring.length < 3) return 0;
  const o = ring[0];
  if (!o) return 0;
  let a2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    if (!p || !q) continue;
    a2 += (p[0] - o[0]) * (q[1] - o[1]) - (q[0] - o[0]) * (p[1] - o[1]);
  }
  return Math.abs(a2) / 2;
}

/** A formatted number with its sign as the boards write it: "−3 308.0", "+19.6", "0.0". */
export function minusSigned(text: string, value: number): string {
  const bare = text.replace(/^[-−+]/, '');
  if (!/[1-9]/.test(bare)) return bare;
  return value < 0 ? `−${bare}` : value > 0 ? `+${bare}` : bare;
}

/**
 * The kit figure a standard-base figure replaced (decision 4), shown as "was" in History on the
 * date of the stored figure it stood for; null when the pile never held one.
 */
export function wasFigure(
  m: Pick<SurveyMeasurement, 'items' | 'results' | 'previousResults'> &
    Partial<Pick<SurveyMeasurement, 'origin'>>,
): { capture: string; netM3: number } | null {
  const kit = (m.previousResults ?? []).filter((r: PreviousResult) => r.label.startsWith('kit, '));
  const last = kit.at(-1);
  if (!last) return null;
  const first = m.items[0];
  const stored = first ? m.results.find((r) => r.item === first.id) : undefined;
  const capture = stored ? seriesDate(stored) : '';
  if (capture === '') return null;
  return { capture, netM3: last.netM3 };
}
