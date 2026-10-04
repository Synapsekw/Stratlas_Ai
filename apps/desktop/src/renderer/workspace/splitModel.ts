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
 * The two sides never show the same pane (one 3D stage, one video player): a clash keeps the left
 * and gives the right the first other option.
 */
export function resolveSplit(pref: SplitPref | undefined, options: readonly PaneKind[]): SplitPref {
  const want = pref ?? DEFAULT_SPLIT;
  const pick = (k: PaneKind, fallback: PaneKind) => (options.includes(k) ? k : fallback);
  const left = pick(want.left, DEFAULT_SPLIT.left);
  let right = pick(want.right, DEFAULT_SPLIT.right);
  if (right === left) right = options.find((o) => o !== left) ?? right;
  return { ...want, left, right };
}

/** Put `kind` on `side`. A pane already on the other side is not offered (see `takenBy`). */
export function chooseSide(pref: SplitPref, side: Side, kind: PaneKind): SplitPref {
  const other = side === 'left' ? pref.right : pref.left;
  if (kind === other) return pref;
  return { ...pref, [side]: kind };
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
  const { left, right, raster, report } = v as Record<string, unknown>;
  const kind = (k: unknown): k is PaneKind =>
    typeof k === 'string' && PANE_KINDS.includes(k as PaneKind);
  if (!kind(left) || !kind(right) || left === right) return null;
  return {
    left,
    right,
    ...(typeof raster === 'string' ? { raster } : {}),
    ...(typeof report === 'string' ? { report } : {}),
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
