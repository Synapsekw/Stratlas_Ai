/**
 * Cut and fill between two survey dates (volumetrics redesign, spec section 6, board 4): one
 * surface-to-surface comparison per pile ring with the threshold as deadband ("Inside piles"),
 * and the engine's whole-site comparison with the same threshold ("Whole site"). Nothing here is
 * estimated: a pile the engine could not compute keeps its status and adds nothing to the totals.
 *
 * The threshold and the area choice are a renderer preference per project (`localStorage`, read
 * and written in try/catch); the pair itself is the app's one compare pair (`compareDates`).
 */
import type {
  ComparisonItem,
  ComparisonResult,
  HeightTiles,
  SurfaceRef,
  SurveyMeasurement,
} from '@aio/schema';
import { figureOn, surfaceOfCapture } from '@aio/survey';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { SiteReply } from '../engineClient';
import type { SiteRequest } from '../engineProtocol';

/** "Ignore under" default, metres (spec: 0.10 m). */
export const CUT_FILL_DEFAULT_M = 0.1;
/** The largest threshold the schema allows a deadband (`deadbandM` ≤ 10 m). */
export const CUT_FILL_MAX_M = 10;
/** Keep a whole-site grid under this many cells (as the whole-site dialog does). */
const MAX_SITE_CELLS = 1_000_000;

export type CutFillArea = 'piles' | 'site';
export type CutFillStatus = 'ok' | 'partial' | 'refused';

export interface CutFillRow {
  id: string;
  /** "P05" for "Pile 05"; any other name as it is. */
  label: string;
  cutM3: number;
  fillM3: number;
  netM3: number;
  status: CutFillStatus;
  /** Why it is partial or refused, when the engine said. */
  reason?: string;
}

export interface CutFillPair {
  from: SurfaceRef;
  to: SurfaceRef;
}

export interface CutFillTotals {
  cutM3: number;
  fillM3: number;
  netM3: number;
  /** Piles added in (refused ones never are). */
  counted: number;
}

/** One pile's comparison: a ring, the item and the date the ring is stored for. */
export type PileRun = (
  ring: [number, number][],
  item: ComparisonItem,
  capture?: string,
  /** The pile's id (a newer run of the same pile cancels the older one). */
  id?: string,
) => Promise<ComparisonResult>;

/** The engine's whole-site comparison (`EngineClient.site`). */
export type SiteRun = (req: SiteRequest, key?: string) => Promise<SiteReply>;

/** The prepared surface of a survey date as a comparison side, or null when it has none yet. */
export function captureRef(surfaces: readonly HeightTiles[], capture: string): SurfaceRef | null {
  const s = surfaceOfCapture(surfaces, capture);
  return s ? { kind: 'survey', surface: s.id, capture } : null;
}

/** The boards' short pile name: "Pile 05" reads "P05"; any other name stays whole. */
export function shortPileLabel(label: string): string {
  const m = /^pile\s+(\S+)$/i.exec(label.trim());
  return m?.[1] ? `P${m[1]}` : label;
}

/** The comparison every pile runs: From to To, the threshold as deadband (0 turns it off). */
export function cutFillItem(pair: CutFillPair, thresholdM: number): ComparisonItem {
  return {
    id: 'cutfill',
    from: pair.from,
    to: pair.to,
    useDeadband: thresholdM > 0,
    deadbandM: Math.max(0, thresholdM),
  };
}

const cancelled = (e: unknown) =>
  e instanceof Error && (e.name === 'RunCancelled' || e.name === 'AbortError');

/** One row per pile, in the order given; a run that fails is a refused row with no figures. */
export async function cutFillByPile(
  piles: readonly SurveyMeasurement[],
  pair: CutFillPair,
  thresholdM: number,
  run: PileRun,
  signal?: AbortSignal,
): Promise<CutFillRow[]> {
  const item = cutFillItem(pair, thresholdM);
  const out: CutFillRow[] = [];
  for (const m of piles) {
    signal?.throwIfAborted();
    const ring = m.points.map((p): [number, number] => [p[0], p[1]]);
    const capture = m.scope.kind === 'survey' ? m.scope.capture : undefined;
    const base = { id: m.id, label: shortPileLabel(m.label) };
    try {
      const r = await run(ring, item, capture, m.id);
      if (r.status === 'refused' || r.status === 'stale') {
        out.push({ ...base, cutM3: 0, fillM3: 0, netM3: 0, status: 'refused', ...why(r) });
      } else {
        out.push({
          ...base,
          cutM3: r.cutM3,
          fillM3: r.fillM3,
          netM3: r.netM3,
          status: r.status,
          ...why(r),
        });
      }
    } catch (e) {
      if (cancelled(e)) throw e;
      out.push({
        ...base,
        cutM3: 0,
        fillM3: 0,
        netM3: 0,
        status: 'refused',
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  signal?.throwIfAborted();
  return out;
}

const why = (r: ComparisonResult) => (r.reason ? { reason: r.reason } : {});

/** The totals of the piles that were computed. */
export function cutFillTotals(rows: readonly CutFillRow[]): CutFillTotals {
  let cutM3 = 0;
  let fillM3 = 0;
  let counted = 0;
  for (const r of rows) {
    if (r.status === 'refused') continue;
    cutM3 += r.cutM3;
    fillM3 += r.fillM3;
    counted++;
  }
  return { cutM3, fillM3, netM3: fillM3 - cutM3, counted };
}

/** A whole-site cell: the finest prepared surface's, coarsened to stay under a million cells. */
export function siteCellM(surfaces: readonly Pick<HeightTiles, 'cellM' | 'bounds'>[]): number {
  if (surfaces.length === 0) return 1;
  const span = Math.max(
    ...surfaces.map((s) => (s.bounds[3] - s.bounds[0]) * (s.bounds[4] - s.bounds[1])),
  );
  const finest = Math.min(...surfaces.map((s) => s.cellM), 1);
  return Math.max(finest, Math.sqrt(span / MAX_SITE_CELLS));
}

/** The whole site between the pair, with the threshold as deadband. */
export async function wholeSiteCutFill(
  pair: CutFillPair,
  thresholdM: number,
  cellM: number,
  site: SiteRun,
): Promise<Omit<CutFillTotals, 'counted'> & { status: ComparisonResult['status'] }> {
  const r = await site(
    { from: pair.from, to: pair.to, cellM, deadbandM: Math.max(0, thresholdM) },
    'cutfill-site',
  );
  return {
    cutM3: r.result.cutM3,
    fillM3: r.result.fillM3,
    netM3: r.result.fillM3 - r.result.cutM3,
    status: r.result.status,
  };
}

/**
 * The inventory's change between the dates: the piles' figures on To minus on From, or null when
 * a pile has no counted figure on either date (the note then says nothing it cannot back).
 */
export function inventoryChange(
  piles: readonly SurveyMeasurement[],
  from: string,
  to: string,
): number | null {
  let sum = 0;
  for (const m of piles) {
    const a = figureOn(m, from);
    const b = figureOn(m, to);
    if (!a || !b) return null;
    if ([a.status, b.status].some((s) => s === 'refused' || s === 'stale')) return null;
    sum += b.netM3 - a.netM3;
  }
  return piles.length > 0 ? sum : null;
}

/** A threshold typed in metres ("0.10" or "0,10"), or null when it is not one the engine takes. */
export function parseThreshold(text: string): number | null {
  const s = text.trim().replace(',', '.');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) && v >= 0 && v <= CUT_FILL_MAX_M ? v : null;
}

// ---------------------------------------------------------------- the per-project preference

export interface CutFillPrefs {
  thresholdM: number;
  area: CutFillArea;
}

/** The part of `localStorage` the preference uses (tests pass a map). */
export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DEFAULT_PREFS: CutFillPrefs = { thresholdM: CUT_FILL_DEFAULT_M, area: 'piles' };
const prefKey = (project: string) => `stratlas.cutFill.${project}`;

function storage(): PrefStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The project's kept threshold and area; the defaults when nothing (or nothing valid) is kept. */
export function readCutFillPrefs(project: string, store = storage()): CutFillPrefs {
  try {
    const raw = store?.getItem(prefKey(project));
    if (!raw) return { ...DEFAULT_PREFS };
    const v = JSON.parse(raw) as { thresholdM?: unknown; area?: unknown };
    const t = v.thresholdM;
    return {
      thresholdM:
        typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= CUT_FILL_MAX_M
          ? t
          : DEFAULT_PREFS.thresholdM,
      area: v.area === 'site' ? 'site' : 'piles',
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Keep the project's threshold and area (a blocked store keeps nothing, quietly). */
export function writeCutFillPrefs(project: string, prefs: CutFillPrefs, store = storage()): void {
  try {
    store?.setItem(prefKey(project), JSON.stringify(prefs));
  } catch {
    // private window or blocked site data: the choice lasts for this session only
  }
}

export interface CutFillPrefsState extends CutFillPrefs {
  project: string | null;
  /** Read the project's kept choice (no-op when it is already loaded). */
  load(project: string | null): void;
  setThreshold(thresholdM: number): void;
  setArea(area: CutFillArea): void;
}

/**
 * The open project's threshold and area, shared by the pane, the heat legend and the strip's
 * Cut & fill bars (they use the same area rule and threshold).
 */
export const cutFillPrefs = createStore<CutFillPrefsState>((set, get) => ({
  ...DEFAULT_PREFS,
  project: null,
  load(project) {
    if (project === get().project) return;
    set({ project, ...(project ? readCutFillPrefs(project) : DEFAULT_PREFS) });
  },
  setThreshold(thresholdM) {
    set({ thresholdM });
    const { project, area } = get();
    if (project) writeCutFillPrefs(project, { thresholdM, area });
  },
  setArea(area) {
    set({ area });
    const { project, thresholdM } = get();
    if (project) writeCutFillPrefs(project, { thresholdM, area });
  },
}));

export function useCutFillPrefs<T>(selector: (s: CutFillPrefsState) => T): T {
  return useStore(cutFillPrefs, selector);
}

// ---------------------------------------------------------------- export

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csvNum = (n: number) => n.toFixed(2);

/** The by-pile figures as CSV (cubic metres, two decimals), then the totals row. */
export function cutFillCsv(
  rows: readonly CutFillRow[],
  head: { pile: string; cut: string; fill: string; net: string; total: string },
): string {
  const lines = [[head.pile, head.cut, head.fill, head.net].map(csvCell).join(',')];
  for (const r of rows) {
    if (r.status === 'refused') continue;
    lines.push([csvCell(r.label), csvNum(r.cutM3), csvNum(r.fillM3), csvNum(r.netM3)].join(','));
  }
  const t = cutFillTotals(rows);
  lines.push([csvCell(head.total), csvNum(t.cutM3), csvNum(t.fillM3), csvNum(t.netM3)].join(','));
  return lines.join('\n');
}
