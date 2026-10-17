import { walkPathPoints, type SurfaceFrame, type WalkFit, type XZ } from '@aio/geo';
import type { DateShift, WalkLayer, WalkRawPath } from '@aio/schema';

/*
 * The walk on a drawing (design "What the surface shows"): its path line, kept stills, pins and
 * current position in the drawing's image pixels. Pure, so the drawing pane and its tests share
 * it; the SVG is `WalkSheetOverlay`, the map's version `walkMapOverlays`.
 */

/** A point in a drawing's image pixels: x right, y down. */
export type SheetPx = [number, number];

export interface WalkDrawing {
  /** The walk layer's id. */
  id: string;
  /** The walk's survey date colour (`var(--date-N)`). */
  colour: string;
  /** The walk is the one being placed (drawn at full strength, with pins and position). */
  placing: boolean;
  /** Runs of the path; a dashed run crosses a stretch without a pin of its own. */
  line: { pts: SheetPx[]; dashed: boolean }[];
  stills: SheetPx[];
  /**
   * Pins in the order of time (`n` from 1); `index` is the pin's place in the calibration's
   * `pins`. An inactive pin (its drawing is gone) sits where the walk was at its time.
   */
  pins: { at: SheetPx; n: number; index: number; active: boolean; role: PinRole }[];
}

/** The first pin by time is the Start handle, the last the End handle (with two or more). */
export type PinRole = 'start' | 'end' | 'pin';

/** The shape being placed, on a drawing: in picture px. */
export interface SheetPreview {
  pts: SheetPx[];
  ghost: boolean;
  tooClose: boolean;
}

export function previewOnSheet(
  xz: readonly XZ[],
  frame: SurfaceFrame,
  ghost: boolean,
  tooClose: boolean,
): SheetPreview {
  const pts = xz.map((p) => toSheet(frame, p)).filter((p) => p.every(Number.isFinite));
  return { pts, ghost, tooClose };
}

/**
 * Where the camera of the walk being placed is at the 360 pane's time, apart from the drawing so
 * a time tick does not redraw the path. `headingRad` is the view direction on the sheet,
 * `atan2(dy, dx)` in image pixels (0 points right, pi/2 down).
 */
export interface WalkNow {
  id: string;
  colour: string;
  at: SheetPx;
  headingRad: number;
}

/** One walk with its live fit and raw path (null for a pins-only walk). */
export interface SheetWalk {
  layer: WalkLayer;
  fit: WalkFit;
  raw: WalkRawPath | null;
  /** The shift of the walk's survey date (line up dates): map and 3D draw it there. */
  shift?: DateShift | null;
}

export interface WalkDrawOptions {
  /** The walk being placed (shown even when unplaced, with its pins and position), or null. */
  placingId: string | null;
  /** Layers switched off in the workspace. */
  hidden?: ReadonlySet<string>;
}

/** The drawing's image px of a model `[x, z]`: the inverse of its affine (non-finite if flat). */
export function toSheet(frame: SurfaceFrame, xz: XZ): SheetPx {
  const det = frame.a * frame.d - frame.b * frame.c;
  const x = xz[0] - frame.tx;
  const z = xz[1] - frame.tz;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) return [NaN, NaN];
  return [(frame.d * x - frame.b * z) / det, (-frame.c * x + frame.a * z) / det];
}

/**
 * A model heading (a three.js `Ry` angle: 0 looks down -Z, north; -pi/2 east) as a direction on
 * the drawing, `atan2(dy, dx)` in image pixels.
 */
export function sheetHeading(frame: SurfaceFrame, headingRad: number): number {
  const dx = -Math.sin(headingRad);
  const dz = -Math.cos(headingRad);
  const det = frame.a * frame.d - frame.b * frame.c;
  const sx = (frame.d * dx - frame.b * dz) / det;
  const sy = (-frame.c * dx + frame.a * dz) / det;
  return Math.atan2(sy, sx);
}

/** A walk shows when it is on and placed, or while it is being placed. */
export function walkShown(layer: WalkLayer, opts: WalkDrawOptions): boolean {
  if (!layer.visible || opts.hidden?.has(layer.id)) return false;
  if (layer.id === opts.placingId) return true;
  return layer.place !== undefined && layer.place.quality !== 'unplaced';
}

/** Pins in the order of time, each where it stands in the model (null when it has no place). */
export function walkPinPoints(
  fit: WalkFit,
): { xz: XZ; n: number; index: number; active: boolean; role: PinRole }[] {
  const out: { xz: XZ; n: number; index: number; active: boolean; role: PinRole }[] = [];
  const last = fit.pins.length - 1;
  fit.pins.forEach((p, k) => {
    const xz = p.active ? p.target : (fit.at(p.t)?.xz ?? null);
    const role: PinRole = k === 0 ? 'start' : k === last ? 'end' : 'pin';
    if (xz) out.push({ xz, n: k + 1, index: p.index, active: p.active, role });
  });
  return out;
}

/** A picture size: points further than 1.5 sheets outside it are not drawn. */
type SheetSize = { width: number; height: number } | undefined;

/** How far around the sheet a point may lie and still be drawn, in sheet sizes on each side. */
const MARGIN = 1.5;

function onSheet(p: SheetPx, s: SheetSize): boolean {
  if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
  if (!s) return true;
  return (
    p[0] >= -MARGIN * s.width &&
    p[0] <= (1 + MARGIN) * s.width &&
    p[1] >= -MARGIN * s.height &&
    p[1] <= (1 + MARGIN) * s.height
  );
}

/**
 * The current position of a walk on one drawing at time `nowT` (seconds), or null when the walk
 * is not placed there yet or the point is far off the sheet. Cheap: one fit lookup.
 */
export function walkNowOnSheet(
  walk: SheetWalk,
  sheet: SurfaceFrame,
  colourOf: (l: WalkLayer) => string,
  nowT: number | null,
  size?: { width: number; height: number },
): WalkNow | null {
  if (nowT === null || !Number.isFinite(nowT)) return null;
  const a = walk.fit.at(nowT);
  if (!a) return null;
  const at = toSheet(sheet, a.xz);
  if (!onSheet(at, size)) return null;
  return {
    id: walk.layer.id,
    colour: colourOf(walk.layer),
    at,
    headingRad: sheetHeading(sheet, a.headingRad),
  };
}

/**
 * Every shown walk on one drawing, in its image pixels. Walks show on every drawing, not only the
 * one they were placed on (the path is in the model frame). `size` is the drawing's picture size:
 * points further than 1.5 sheets outside it are dropped, so a far path makes no huge SVG.
 */
export function walkDrawingsForSheet(
  walks: readonly SheetWalk[],
  sheet: SurfaceFrame,
  colourOf: (l: WalkLayer) => string,
  opts: WalkDrawOptions & { size?: { width: number; height: number } },
): WalkDrawing[] {
  const inside = (p: SheetPx): boolean => onSheet(p, opts.size);
  const out: WalkDrawing[] = [];
  for (const { layer, fit, raw } of walks) {
    if (!walkShown(layer, opts)) continue;
    const placing = layer.id === opts.placingId;
    const path = walkPathPoints(fit, raw, layer.durationS);
    const line: WalkDrawing['line'] = [];
    for (const run of path.line) {
      const dashed = run.at(-1)?.dashed ?? false;
      let pts: SheetPx[] = [];
      for (const p of run) {
        const px = toSheet(sheet, p.xz);
        if (inside(px)) pts.push(px);
        else {
          if (pts.length > 1) line.push({ pts, dashed });
          pts = [];
        }
      }
      if (pts.length > 1) line.push({ pts, dashed });
    }
    const stills = path.stills.map((s) => toSheet(sheet, s.xz)).filter(inside);
    const pins = placing
      ? walkPinPoints(fit)
          .map((p) => ({
            at: toSheet(sheet, p.xz),
            n: p.n,
            index: p.index,
            active: p.active,
            role: p.role,
          }))
          .filter((p) => inside(p.at))
      : [];
    out.push({ id: layer.id, colour: colourOf(layer), placing, line, stills, pins });
  }
  return out;
}
