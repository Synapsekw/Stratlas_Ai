import type {
  CaptureLineUp,
  Issue,
  Layer,
  LineUpMeasure,
  ProjectManifest,
  SurveyMeasurement,
} from '@aio/schema';
import type { t as translate } from '@aio/ui';
import { captureIndex, captureShift, layerDateShifts, shiftKey } from '@aio/workspace';
import type { Box } from '../shell/layerBounds';

/**
 * The line-up step without the app: what a measured correction writes on which date, what moves
 * with that date, how a shift reads, and which pairs of dates the background check measures.
 */

type T = typeof translate;

const mm = (v: number) => Math.round(v * 1000) / 1000;

export interface LineUpPlan {
  /** The date that moves (the one not kept). */
  moveId: string;
  /** Its new, absolute `lineUp`. */
  lineUp: CaptureLineUp;
  /** What it had before (null: none), for Undo. */
  previous: CaptureLineUp | null;
  /** How far it moves, metres. */
  totalM: number;
  /** The new shift is finite and within the 500 m a line-up may hold; else it cannot be saved. */
  inRange: boolean;
}

/** The most a line-up may shift a date, metres east or north (`CaptureLineUp`). */
const MAX_SHIFT_M = 500;

/**
 * The `lineUp` that brings the dates together. The measurement is the correction `m.move` still
 * needs, between the dates as placed now: keep `m.keep` and `m.move` takes its current shift plus
 * the correction; keep `m.move` and `m.keep` takes its current shift minus it.
 */
export function planLineUp(
  m: LineUpMeasure,
  keepId: string,
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  at: string,
): LineUpPlan {
  const keepIsKeep = keepId === m.keep;
  const moveId = keepIsKeep ? m.move : m.keep;
  const sign = keepIsKeep ? 1 : -1;
  const now = captureShift(manifest, moveId) ?? { eastM: 0, northM: 0 };
  const previous = manifest.captures.find((c) => c.id === moveId)?.lineUp ?? null;
  const spreadM = mm(m.spreadPx * m.cellM);
  const eastM = mm(now.eastM + sign * m.eastM);
  const northM = mm(now.northM + sign * m.northM);
  const fits = (v: number) => Number.isFinite(v) && Math.abs(v) <= MAX_SHIFT_M;
  return {
    moveId,
    lineUp: {
      eastM,
      northM,
      with: keepId,
      ...(Number.isFinite(spreadM) && spreadM >= 0 ? { spreadM } : {}),
      at,
    },
    previous,
    totalM: mm(Math.hypot(m.eastM, m.northM)),
    inRange: fits(eastM) && fits(northM),
  };
}

/** The layers that take a date's shift: those the resolver gives a shift once the date has one. */
function movingLayers(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  captureId: string,
): Set<string> {
  // the resolver answers for dates that carry a shift: give this one a stand-in to ask it
  const probe = {
    captures: manifest.captures.map((c) =>
      c.id === captureId
        ? { ...c, lineUp: { eastM: 1, northM: 1, with: c.id, at: '1970-01-01T00:00:00Z' } }
        : c,
    ),
    layers: manifest.layers,
  };
  const of = captureIndex(manifest).of;
  return new Set(Object.keys(layerDateShifts(probe)).filter((id) => of[id] === captureId));
}

/**
 * What moves with a date: its datasets, the issues with a sighting on one of them, and the
 * survey measurements scoped to it. Site measurements never move.
 */
export function movesWith(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  captureId: string,
  issues: readonly Issue[],
  measurements: readonly SurveyMeasurement[],
): { layers: number; items: number } {
  const layers = movingLayers(manifest, captureId);
  const onIt = issues.filter((i) => i.sightings.some((s) => layers.has(s.layer))).length;
  const scoped = measurements.filter(
    (s) => s.scope.kind === 'survey' && s.scope.capture === captureId,
  ).length;
  return { layers: layers.size, items: onIt + scoped };
}

/** "2.01 m": a shown distance, two decimals. */
export function formatMetres(m: number): string {
  return `${(Math.abs(m) < 0.005 ? 0 : m).toFixed(2)} m`;
}

/** "2.01 m west, 0.00 m north (2.01 m in all)". */
export function shiftWords(eastM: number, northM: number, t: T): string {
  return t('lineUp.shift', {
    ew: t(eastM < 0 ? 'lineUp.west' : 'lineUp.east', { distance: formatMetres(Math.abs(eastM)) }),
    ns: t(northM < 0 ? 'lineUp.south' : 'lineUp.north', {
      distance: formatMetres(Math.abs(northM)),
    }),
    distance: formatMetres(Math.hypot(eastM, northM)),
  });
}

export interface LineUpPair {
  keep: string;
  move: string;
  layerKeep: string;
  layerMove: string;
  /**
   * `"<layer>|<layer>"`, the two layer ids sorted, each with `@<shift>` when its date is lined up:
   * one pair whichever date it was found from, and a new pair once either date moves (call 11).
   */
  key: string;
}

const isRole = (l: Layer, role: 'ortho' | 'dsm') =>
  l.kind === 'raster' && l.role === role && l.derived?.kind !== 'change';

/** Plan overlap of two boxes, square metres (x east, z south). */
function overlap(a: Box, b: Box): number {
  const w = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const h = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The pairs the background check measures: each date with an ortho (or, when neither has one, a
 * DSM) against the other date it most overlaps, the earlier date kept. The layers are the ones
 * `change.lineup` reads by default (each date's first ortho, else its first DSM); a pair of an
 * ortho and a DSM is not measured. Pairs in `measured` (by key) are left out.
 */
export function pairsToMeasure(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  extents: Readonly<Record<string, Box>>,
  measured: ReadonlySet<string>,
): LineUpPair[] {
  const index = captureIndex(manifest);
  const byId = new Map(manifest.layers.map((l) => [l.id, l]));
  const first = (captureId: string, role: 'ortho' | 'dsm') =>
    (index.layers[captureId] ?? [])
      .map((id) => byId.get(id))
      .find((l): l is Layer => l !== undefined && isRole(l, role));
  const imageOf = (captureId: string) => ({
    ortho: first(captureId, 'ortho'),
    dsm: first(captureId, 'dsm'),
  });
  const order = index.captures.map((c) => c.id);
  const out: LineUpPair[] = [];
  const seen = new Set<string>();
  for (const a of order) {
    const ia = imageOf(a);
    let best: { b: string; la: string; lb: string; area: number } | null = null;
    for (const b of order) {
      if (b === a) continue;
      const ib = imageOf(b);
      // as the job picks: the orthos, else (no ortho on either) the DSMs
      const [la, lb] = ia.ortho || ib.ortho ? [ia.ortho, ib.ortho] : [ia.dsm, ib.dsm];
      if (!la || !lb) continue;
      const ea = extents[la.id];
      const eb = extents[lb.id];
      const area = ea && eb ? overlap(ea, eb) : 0;
      if (area > 0 && (!best || area > best.area)) best = { b, la: la.id, lb: lb.id, area };
    }
    if (!best) continue;
    const tag = (layerId: string, captureId: string) => {
      const s = shiftKey(captureShift(manifest, captureId));
      return s ? `${layerId}@${s}` : layerId;
    };
    const key = [tag(best.la, a), tag(best.lb, best.b)].sort().join('|');
    if (seen.has(key) || measured.has(key)) continue;
    seen.add(key);
    const aFirst = order.indexOf(a) < order.indexOf(best.b);
    out.push(
      aFirst
        ? { keep: a, move: best.b, layerKeep: best.la, layerMove: best.lb, key }
        : { keep: best.b, move: a, layerKeep: best.lb, layerMove: best.la, key },
    );
  }
  return out;
}
