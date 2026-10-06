import { ProcModel, type Layer, type ProjectManifest } from '@aio/schema';

/**
 * Imported drawings (the `drawing.import` pipeline): what the app needs to list them, read their
 * candidate parts and place them by control points. Files of one drawing `<stem>`:
 * `drawings/<stem>.dxf` (the copy), `drawings/<stem>/plan.png` (the plan raster layer
 * `plan-<stem>`), `drawings/<stem>/parts.procmodel.json` (candidate parts, `aio.procmodel/1`)
 * and `drawings/<stem>/placement.json` (how drawing coordinates map to the local frame).
 */

/**
 * `drawings/<stem>/placement.json`, written by the pipeline (local type of stream C5; proposed
 * for data-conventions section 15): a drawing point (dx, dy) in drawing units lies at
 * `x = a*dx + b*dy + tx`, `z = c*dx + d*dy + tz` in the local frame, at height `baseY`.
 */
export interface DrawingPlacement {
  schema: 'aio.drawingplacement/1';
  file: string;
  units: string;
  unitM: number;
  matrix: [number, number, number, number, number, number];
  baseY: number;
  rmsM?: number | null;
  control?: unknown[];
  provisional?: boolean;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Read a placement file; throws a message a person can act on. */
export function parsePlacement(json: unknown): DrawingPlacement {
  const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  const m = o.matrix;
  if (
    o.schema !== 'aio.drawingplacement/1' ||
    typeof o.file !== 'string' ||
    typeof o.units !== 'string' ||
    !num(o.unitM) ||
    o.unitM <= 0 ||
    !num(o.baseY) ||
    !Array.isArray(m) ||
    m.length !== 6 ||
    !m.every(num)
  ) {
    throw new Error('The drawing placement is not valid. Import the drawing again.');
  }
  return o as unknown as DrawingPlacement;
}

export interface DrawingInfo {
  stem: string;
  /** Display name: the plan layer's name without " plan". */
  name: string;
  planLayer: string;
  dxf: string;
  plan: string;
  parts: string;
  placement: string;
}

const PLAN = /^drawings\/([A-Za-z0-9][A-Za-z0-9_-]{0,80})\/plan\.png$/;

/** Drawings imported into a project, newest (last in the manifest) first. */
export function drawingsOf(
  manifest: Pick<ProjectManifest, 'layers'> | null | undefined,
): DrawingInfo[] {
  const out: DrawingInfo[] = [];
  for (const l of manifest?.layers ?? []) {
    if (l.kind !== 'raster' || l.role !== 'plan' || !('path' in l.src)) continue;
    const stem = PLAN.exec(l.src.path.replace(/\\/g, '/'))?.[1];
    if (!stem) continue;
    out.push({
      stem,
      name: l.name.replace(/ plan$/, ''),
      planLayer: l.id,
      dxf: `drawings/${stem}.dxf`,
      plan: l.src.path,
      parts: `drawings/${stem}/parts.procmodel.json`,
      placement: `drawings/${stem}/placement.json`,
    });
  }
  return out.reverse();
}

/** A drawing by stem or name (case-insensitive), or the newest. */
export function findDrawing(list: readonly DrawingInfo[], key?: string): DrawingInfo | undefined {
  if (!key) return list[0];
  const k = key.trim().toLowerCase();
  return list.find(
    (d) =>
      d.stem.toLowerCase() === k ||
      d.name.toLowerCase() === k ||
      d.name.toLowerCase().replace(/\.dxf$/, '') === k,
  );
}

export function drawingToLocal(
  p: DrawingPlacement,
  d: readonly [number, number],
): [number, number] {
  const [a, b, c, dd, tx, tz] = p.matrix;
  return [a * d[0] + b * d[1] + tx, c * d[0] + dd * d[1] + tz];
}

/** The drawing point (drawing units) under a local point [x, z], or null when not invertible. */
export function localToDrawing(
  p: DrawingPlacement,
  xz: readonly [number, number],
): [number, number] | null {
  const [a, b, c, d, tx, tz] = p.matrix;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-15) return null;
  const x = xz[0] - tx;
  const z = xz[1] - tz;
  return [(d * x - b * z) / det, (-c * x + a * z) / det];
}

/** Candidate parts of an imported drawing, from its parts file. */
export function readDrawingParts(json: unknown): ProcModel {
  const r = ProcModel.safeParse(json);
  if (!r.success)
    throw new Error('The parts read from the drawing are not valid. Import it again.');
  return r.data;
}

/** True for the plan raster layer of an imported drawing. */
export function isDrawingPlan(l: Layer): boolean {
  return l.kind === 'raster' && l.role === 'plan' && 'path' in l.src && PLAN.test(l.src.path);
}
