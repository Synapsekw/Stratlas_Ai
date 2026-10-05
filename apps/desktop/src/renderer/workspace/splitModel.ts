import type { Layer } from '@aio/schema';

/** What one side of the split stage shows. */
export type PaneKind = '3d' | 'map' | 'video' | 'photo' | 'raster' | 'report';

export type Side = 'left' | 'right';

export interface SplitPref {
  left: PaneKind;
  right: PaneKind;
  /** The raster layer the Ortho pane shows (absent: the first). */
  raster?: string;
  /** The report file the Report pane shows (absent: the first). */
  report?: string;
  /** Survey date (capture id) the left side shows, for panes drawn per date (3D, map, ortho). */
  leftCapture?: string;
  /** Survey date (capture id) the right side shows. */
  rightCapture?: string;
  /** Two panes of one kind move on their own (absent: linked camera, pan and zoom). */
  unlinked?: boolean;
}

/**
 * Panes that can show twice when they show two survey dates: one 3D view per date, one map or
 * ortho per date. The video player, photos and the report stay single.
 */
export const PER_CAPTURE: readonly PaneKind[] = ['3d', 'map', 'raster'];

/** The project's survey dates for the split (capture ids, oldest first). */
export interface SplitDates {
  captures: readonly string[];
  /** Two 3D views may run (not on the Low graphics tier). Default true. */
  twin3d?: boolean;
}

/** Whether both sides may show `kind`, one survey date each. */
export function twinAllowed(kind: PaneKind, dates: SplitDates | undefined): boolean {
  if (!dates || dates.captures.length < 2 || !PER_CAPTURE.includes(kind)) return false;
  return kind !== '3d' || dates.twin3d !== false;
}

const captureKey = (side: Side) => (side === 'left' ? 'leftCapture' : 'rightCapture');

/**
 * The capture a side shows: the remembered one when the project has it, else the latest survey
 * (the first one on the left of two panes of one kind, which compare the first and last dates).
 */
export function sideCapture(
  pref: SplitPref,
  side: Side,
  dates: SplitDates | undefined,
): string | undefined {
  if (!dates || dates.captures.length === 0) return undefined;
  const want = pref[captureKey(side)];
  if (want && dates.captures.includes(want)) return want;
  return side === 'left' && pref.left === pref.right ? dates.captures[0] : dates.captures.at(-1);
}

/** Both sides on their captures, never the same date twice on a pane shown twice. */
function withCaptures(pref: SplitPref, dates: SplitDates | undefined): SplitPref {
  if (!dates || dates.captures.length === 0) return pref;
  const l = sideCapture(pref, 'left', dates);
  let r = sideCapture(pref, 'right', dates);
  if (pref.left === pref.right && l !== undefined && r === l)
    r = dates.captures.find((c) => c !== l) ?? r;
  return {
    ...pref,
    ...(l !== undefined ? { leftCapture: l } : {}),
    ...(r !== undefined ? { rightCapture: r } : {}),
  };
}

/** Compare two dates: `kind` on both sides, the first date on the left and the last on the right. */
export function compareSplit(pref: SplitPref, kind: PaneKind, dates: SplitDates): SplitPref {
  const first = dates.captures[0];
  const last = dates.captures.at(-1);
  return {
    ...pref,
    left: kind,
    right: kind,
    ...(first !== undefined ? { leftCapture: first } : {}),
    ...(last !== undefined ? { rightCapture: last } : {}),
  };
}

/** Show `capture` on `side`; when both sides show the same pane, the other side takes the old date. */
export function chooseCapture(
  pref: SplitPref,
  side: Side,
  capture: string,
  dates?: SplitDates,
): SplitPref {
  const resolved = withCaptures(pref, dates);
  const mine = captureKey(side);
  const theirs = captureKey(side === 'left' ? 'right' : 'left');
  const next: SplitPref = { ...resolved, [mine]: capture };
  if (resolved.left === resolved.right && resolved[theirs] === capture) {
    const old = resolved[mine];
    if (old !== undefined) next[theirs] = old;
  }
  return next;
}

/** Every side that shows `kind` in split mode. */
export function sidesOf(pref: SplitPref, kind: PaneKind): Side[] {
  return (['left', 'right'] as const).filter((s) => pref[s] === kind);
}

/** The pane the other side shows when this side may not pick it too, else null. */
export function blockedFor(pref: SplitPref, side: Side, dates?: SplitDates): PaneKind | null {
  const other = takenBy(pref, side);
  return twinAllowed(other, dates) ? null : other;
}

export const PANE_KINDS: readonly PaneKind[] = ['3d', 'map', 'video', 'photo', 'raster', 'report'];

/** As today: the 3D view on the left, the map on the right. */
export const DEFAULT_SPLIT: SplitPref = { left: '3d', right: 'map' };

/** The panes a project can fill: the 3D view and the map always, the rest when it has the data. */
export function paneOptions(layers: readonly Pick<Layer, 'kind'>[], reports: number): PaneKind[] {
  const has = (k: Layer['kind']) => layers.some((l) => l.kind === k);
  return PANE_KINDS.filter((k) => {
    switch (k) {
      case '3d':
      case 'map':
        return true;
      case 'video':
        return has('video');
      case 'photo':
        return has('photos');
      case 'raster':
        return has('raster');
      case 'report':
        return reports > 0;
    }
  });
}

/**
 * The sides to draw: the remembered choice where the project still offers it, else the default.
 * The two sides show the same pane only to compare two survey dates (3D, map or ortho, one date
 * each; `dates`); otherwise a clash keeps the left and gives the right the first other option
 * (one video player, and the 3D view at most once per date).
 */
export function resolveSplit(
  pref: SplitPref | undefined,
  options: readonly PaneKind[],
  dates?: SplitDates,
): SplitPref {
  const want = pref ?? DEFAULT_SPLIT;
  const pick = (k: PaneKind, fallback: PaneKind) => (options.includes(k) ? k : fallback);
  const left = pick(want.left, DEFAULT_SPLIT.left);
  let right = pick(want.right, DEFAULT_SPLIT.right);
  if (right === left && !twinAllowed(left, dates)) right = options.find((o) => o !== left) ?? right;
  return withCaptures({ ...want, left, right }, dates);
}

/**
 * Put `kind` on `side`. A pane already on the other side is not offered (see `blockedFor`),
 * except to show a second survey date: then this side takes a date the other does not show.
 */
export function chooseSide(
  pref: SplitPref,
  side: Side,
  kind: PaneKind,
  dates?: SplitDates,
): SplitPref {
  const other = side === 'left' ? pref.right : pref.left;
  if (kind === other && !twinAllowed(kind, dates)) return pref;
  return withCaptures({ ...pref, [side]: kind }, dates);
}

/** The pane the other side shows: disabled in this side's chooser. */
export function takenBy(pref: SplitPref, side: Side): PaneKind {
  return side === 'left' ? pref.right : pref.left;
}

/** Which side shows `kind` in split mode, if any. */
export function sideOf(pref: SplitPref, kind: PaneKind): Side | undefined {
  return pref.left === kind ? 'left' : pref.right === kind ? 'right' : undefined;
}

/** A remembered choice read back from storage, or null when it is not one. */
export function parseSplitPref(v: unknown): SplitPref | null {
  if (!v || typeof v !== 'object') return null;
  const { left, right, raster, report, leftCapture, rightCapture, unlinked } = v as Record<
    string,
    unknown
  >;
  const kind = (k: unknown): k is PaneKind =>
    typeof k === 'string' && PANE_KINDS.includes(k as PaneKind);
  if (!kind(left) || !kind(right)) return null;
  // the same pane twice only for two different survey dates
  if (
    left === right &&
    !(
      PER_CAPTURE.includes(left) &&
      typeof leftCapture === 'string' &&
      typeof rightCapture === 'string' &&
      leftCapture !== rightCapture
    )
  )
    return null;
  return {
    left,
    right,
    ...(typeof raster === 'string' ? { raster } : {}),
    ...(typeof report === 'string' ? { report } : {}),
    ...(typeof leftCapture === 'string' ? { leftCapture } : {}),
    ...(typeof rightCapture === 'string' ? { rightCapture } : {}),
    ...(unlinked === true ? { unlinked: true } : {}),
  };
}

/* ----------------------------------------------------------------------- raster pyramid */

export interface PyramidLevel {
  z: number;
  tileSize: number;
  cols: number;
  rows: number;
  pattern: string;
}

/** The `aio.tiles/1` index of a `kit-pyramid` raster, coarse to fine; null when unreadable. */
export function parsePyramid(json: unknown): PyramidLevel[] | null {
  if (!json || typeof json !== 'object') return null;
  const levels = (json as { levels?: unknown }).levels;
  if (!Array.isArray(levels)) return null;
  const out = levels.filter(
    (l): l is PyramidLevel =>
      !!l &&
      typeof l === 'object' &&
      typeof (l as PyramidLevel).z === 'number' &&
      typeof (l as PyramidLevel).pattern === 'string' &&
      (l as PyramidLevel).tileSize > 0 &&
      (l as PyramidLevel).cols > 0 &&
      (l as PyramidLevel).rows > 0,
  );
  out.sort((a, b) => a.cols * a.tileSize - b.cols * b.tileSize);
  return out.length ? out : null;
}

/** Pixel size of the full image at the finest level. */
export function pyramidSize(levels: readonly PyramidLevel[]): { width: number; height: number } {
  const f = levels.at(-1);
  return f ? { width: f.cols * f.tileSize, height: f.rows * f.tileSize } : { width: 1, height: 1 };
}

/**
 * The coarsest level that still has a source pixel for every screen pixel at `scale` (screen
 * pixels per finest-level pixel, device pixel ratio included); the finest when none does.
 */
export function levelFor(levels: readonly PyramidLevel[], scale: number): PyramidLevel | undefined {
  const full = pyramidSize(levels).width;
  return levels.find((l) => l.cols * l.tileSize >= full * scale * 0.999) ?? levels.at(-1);
}

/**
 * Tiles of `level` that meet the view: `view` is the visible rectangle in finest-level pixels.
 */
export function visibleTiles(
  level: PyramidLevel,
  full: { width: number },
  view: { x: number; y: number; width: number; height: number },
): { x: number; y: number }[] {
  const f = full.width / (level.cols * level.tileSize);
  const size = level.tileSize * f;
  const x0 = Math.max(0, Math.floor(view.x / size));
  const y0 = Math.max(0, Math.floor(view.y / size));
  const x1 = Math.min(level.cols - 1, Math.floor((view.x + view.width) / size));
  const y1 = Math.min(level.rows - 1, Math.floor((view.y + view.height) / size));
  const out: { x: number; y: number }[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y });
  return out;
}

export function tilePath(level: PyramidLevel, x: number, y: number): string {
  return level.pattern
    .replace('{z}', String(level.z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}
