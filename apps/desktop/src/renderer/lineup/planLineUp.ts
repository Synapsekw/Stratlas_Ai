import {
  composeShift,
  hasTurn,
  invertShift,
  turnOf,
  type CaptureLineUp,
  type CaptureLineUpTurn,
  type DateShift,
  type Issue,
  type Layer,
  type LineUpMeasure,
  type ProjectManifest,
  type SurveyMeasurement,
  type Vec3,
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
// a turned line-up keeps its shift to the micrometre: the shift moves the pivot, and the pair
// must apply as the two corrections in order (rounding stays far below a millimetre)
const um = (v: number) => Math.round(v * 1e6) / 1e6;

export interface LineUpPlan {
  /** The date that moves (the one not kept). */
  moveId: string;
  /** Its new, absolute `lineUp`. */
  lineUp: CaptureLineUp;
  /** Its new `lineUpTurn`, saved with `lineUp` as a pair (null: a plain shift). */
  lineUpTurn: CaptureLineUpTurn | null;
  /** What it had before (null: none), for Undo. */
  previous: CaptureLineUp | null;
  /** The turn it had before (null: none), restored with `previous`. */
  previousTurn: CaptureLineUpTurn | null;
  /** How far it moves, metres: the largest move over the overlap when the fit gives it. */
  totalM: number;
  /**
   * The new line-up is finite and within what a date may hold (500 m east and north, and the
   * stored turn envelope of `CaptureLineUpTurn`: 2 degrees, scale within 2%) and the move is at
   * most 500 m; else it cannot be saved.
   */
  inRange: boolean;
}

/** The most a line-up may shift a date, metres east or north (`CaptureLineUp`). */
const MAX_SHIFT_M = 500;
/** The stored envelope of a turn (`CaptureLineUpTurn`), which composed line-ups may reach. */
const MAX_TURN_DEG = 2;
const MIN_SCALE = 0.98;
const MAX_SCALE = 1.02;

/**
 * The correction `m.move` still needs, between the dates as placed now: the fit's shift, turn and
 * scale about its pivot when `lineup-fit.json` came with the measurement, else the plain shift
 * (an older pipeline pack). `origin` places the pivot in the local frame.
 */
export function correctionOf(m: LineUpMeasure, origin: Vec3): DateShift {
  const f = m.fit;
  if (!f) return { eastM: m.eastM, northM: m.northM };
  return {
    eastM: f.eastM,
    northM: f.northM,
    turn: {
      rotationDeg: f.rotationDeg,
      scale: f.scale,
      pivotE: f.pivotE,
      pivotN: f.pivotN,
      pivotX: f.pivotE - origin[0],
      pivotZ: origin[1] - f.pivotN,
    },
  };
}

/**
 * The correction the date that moves takes once `keepId` is kept: the measured one when `m.keep`
 * stays (or none is chosen yet), its inverse when `m.move` stays and `m.keep` moves onto it.
 */
export function stepOf(m: LineUpMeasure, keepId: string | null, origin: Vec3): DateShift {
  const c = correctionOf(m, origin);
  return keepId === m.move ? invertShift(c) : c;
}

const turnFits = (t: CaptureLineUpTurn | null) =>
  !t ||
  (Number.isFinite(t.pivotE) &&
    Number.isFinite(t.pivotN) &&
    Math.abs(t.rotationDeg) <= MAX_TURN_DEG &&
    t.scale >= MIN_SCALE &&
    t.scale <= MAX_SCALE);

/**
 * The `lineUp` and `lineUpTurn` that bring the dates together. The date that moves takes the
 * correction on top of its current line-up (`composeShift`): keep `m.keep` and `m.move` takes the
 * correction; keep `m.move` and `m.keep` takes its inverse. A turned pair is expressed about the
 * newer pivot; a plain correction on a turned date keeps the date's own pivot.
 */
export function planLineUp(
  m: LineUpMeasure,
  keepId: string,
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>,
  at: string,
): LineUpPlan {
  const moveId = keepId === m.keep ? m.move : m.keep;
  const now = captureShift(manifest, moveId) ?? { eastM: 0, northM: 0 };
  const capture = manifest.captures.find((c) => c.id === moveId);
  const previous = capture?.lineUp ?? null;
  // a turn is only ever read beside its lineUp
  const previousTurn = previous ? (capture?.lineUpTurn ?? null) : null;
  const next = composeShift(now, stepOf(m, keepId, manifest.origin));
  const lineUpTurn = turnOf(next);
  const round = lineUpTurn ? um : mm;
  const spreadM = mm(m.spreadPx * m.cellM);
  const eastM = round(next.eastM);
  const northM = round(next.northM);
  const totalM = mm(m.fit?.maxMoveM ?? Math.hypot(m.eastM, m.northM));
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
    lineUpTurn,
    previous,
    previousTurn,
    totalM,
    inRange: fits(eastM) && fits(northM) && fits(totalM) && turnFits(lineUpTurn),
  };
}

/** The layers that take a date's shift: those the resolver gives a shift once the date has one. */
function movingLayers(
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>,
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
    origin: manifest.origin,
  };
  const of = captureIndex(manifest).of;
  return new Set(Object.keys(layerDateShifts(probe)).filter((id) => of[id] === captureId));
}

/**
 * What moves with a date: its datasets, the issues with a sighting on one of them, and the
 * survey measurements scoped to it. Site measurements never move.
 */
export function movesWith(
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>,
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

/** "turned 0.25°, scaled +0.35%": degrees and a signed percent, two decimals each. */
export function turnWords(turn: { rotationDeg: number; scale: number }, t: T): string {
  const fixed = (v: number) => {
    const s = v.toFixed(2);
    return s === '-0.00' ? '0.00' : s;
  };
  const pct = fixed((turn.scale - 1) * 100);
  return t('lineUp.turn', {
    deg: fixed(turn.rotationDeg),
    pct: `${pct.startsWith('-') ? '' : '+'}${pct}%`,
  });
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
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>,
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

/**
 * The date to line `captureId` up with from its menu: the other date when there are two, else
 * the one whose imagery overlaps its own the most in plan. Null when no other date overlaps it.
 */
export function partnerOf(
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>,
  extents: Readonly<Record<string, Box>>,
  captureId: string,
): string | null {
  const others = manifest.captures.filter((c) => c.id !== captureId);
  if (!manifest.captures.some((c) => c.id === captureId)) return null;
  const only = others[0];
  if (others.length === 1 && only) return only.id;
  const index = captureIndex(manifest);
  const byId = new Map(manifest.layers.map((l) => [l.id, l]));
  const boxes = (id: string): Box[] =>
    (index.layers[id] ?? []).flatMap((layerId) => {
      const l = byId.get(layerId);
      const box = extents[layerId];
      return l && (isRole(l, 'ortho') || isRole(l, 'dsm')) && box ? [box] : [];
    });
  const mine = boxes(captureId);
  let best: { id: string; area: number } | null = null;
  for (const c of others) {
    let area = 0;
    for (const a of mine) for (const b of boxes(c.id)) area = Math.max(area, overlap(a, b));
    if (area > 0 && (!best || area > best.area)) best = { id: c.id, area };
  }
  return best?.id ?? null;
}

/**
 * The folder tooltip line of a lined-up date ("Lined up with ... (2.01 m)", and with a turn
 * "(2.01 m, turned 0.11°, scaled -0.18%)"); null for none.
 */
export function lineUpTip(
  manifest: Pick<ProjectManifest, 'captures'>,
  captureId: string,
  t: T,
): string | null {
  const c = manifest.captures.find((x) => x.id === captureId);
  if (!c?.lineUp) return null;
  const kept = manifest.captures.find((x) => x.id === c.lineUp?.with);
  const distance = formatMetres(Math.hypot(c.lineUp.eastM, c.lineUp.northM));
  return t('lineUp.folder', {
    kept: kept?.label ?? c.lineUp.with,
    distance:
      c.lineUpTurn && hasTurn(c.lineUpTurn)
        ? `${distance}, ${turnWords(c.lineUpTurn, t)}`
        : distance,
  });
}
