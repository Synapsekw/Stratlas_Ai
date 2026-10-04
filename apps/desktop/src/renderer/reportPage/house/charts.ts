// Charts of the house report as inline SVG: the findings map from above and from the side.
import type { PlanPoint } from '@aio/project/export';
import { esc } from '../layout';

/** 1, 2 or 5 times a power of ten, the largest not above `x`. */
export function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  const f = x / p;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
}

interface Box {
  minA: number;
  maxA: number;
  minB: number;
  maxB: number;
}

/** Bounds of two coordinates of the points, padded so a single point still has an extent. */
function bounds(
  points: readonly PlanPoint[],
  a: (p: PlanPoint) => number,
  b: (p: PlanPoint) => number,
): Box {
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (const p of points) {
    minA = Math.min(minA, a(p));
    maxA = Math.max(maxA, a(p));
    minB = Math.min(minB, b(p));
    maxB = Math.max(maxB, b(p));
  }
  const pad = Math.max(1, (maxA - minA) * 0.06, (maxB - minB) * 0.06);
  return { minA: minA - pad, maxA: maxA + pad, minB: minB - pad, maxB: maxB + pad };
}

/**
 * Scatter of issue positions with equal scale on both axes, a scale bar, and (plan view) a
 * north arrow. `a` runs right, `b` runs up. Worst issues are drawn last, on top.
 */
function scatter(
  points: readonly PlanPoint[],
  a: (p: PlanPoint) => number,
  b: (p: PlanPoint) => number,
  opts: { width: number; height: number; north: boolean; label: string },
): string {
  const { width, height } = opts;
  const margin = 18;
  const box = bounds(points, a, b);
  const k = Math.min(
    (width - 2 * margin) / (box.maxA - box.minA),
    (height - 2 * margin - 14) / (box.maxB - box.minB),
  );
  const w = (box.maxA - box.minA) * k;
  const h = (box.maxB - box.minB) * k;
  const ox = (width - w) / 2;
  const oy = (height - 14 - h) / 2;
  const X = (v: number) => ox + (v - box.minA) * k;
  const Y = (v: number) => oy + h - (v - box.minB) * k;
  const r = Math.max(2.2, Math.min(4.5, 900 / Math.max(1, points.length) ** 0.75));
  const dots = points
    .map(
      (p) =>
        `<circle cx="${X(a(p)).toFixed(1)}" cy="${Y(b(p)).toFixed(1)}" r="${r.toFixed(1)}" fill="${esc(p.color)}" stroke="#ffffff" stroke-width="0.6"/>`,
    )
    .join('');
  // scale bar: a nice length near a quarter of the drawing
  const step = niceStep((box.maxA - box.minA) / 4);
  const sx = ox;
  const sy = height - 6;
  const scale = `<g class="scale"><line x1="${sx.toFixed(1)}" y1="${sy}" x2="${(sx + step * k).toFixed(1)}" y2="${sy}"/><line x1="${sx.toFixed(1)}" y1="${sy - 3}" x2="${sx.toFixed(1)}" y2="${sy + 1}"/><line x1="${(sx + step * k).toFixed(1)}" y1="${sy - 3}" x2="${(sx + step * k).toFixed(1)}" y2="${sy + 1}"/><text x="${(sx + step * k + 4).toFixed(1)}" y="${sy + 3}">${esc(String(step))} m</text></g>`;
  const north = opts.north
    ? `<g class="north" transform="translate(${(width - 14).toFixed(1)},16)"><path d="M0,-10 L5,6 L0,3 L-5,6 Z"/><text y="18" text-anchor="middle">N</text></g>`
    : '';
  const frame = `<rect class="frame" x="${ox.toFixed(1)}" y="${oy.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`;
  return `<svg class="map" viewBox="0 0 ${String(width)} ${String(height)}" width="100%" role="img" aria-label="${esc(opts.label)}">${frame}${dots}${scale}${north}</svg>`;
}

/** Points sorted so the most severe (drawn last) end on top; uses the order of `rank`. */
function ordered(points: readonly PlanPoint[], rank: ReadonlyMap<string, number>): PlanPoint[] {
  return [...points].sort((p, q) => (rank.get(p.color) ?? 0) - (rank.get(q.color) ?? 0));
}

/** The findings map seen from above: x east to the right, north (-z) up. */
export function planMap(
  points: readonly PlanPoint[],
  rank: ReadonlyMap<string, number>,
  label: string,
  size = { width: 340, height: 260 },
): string {
  return scatter(
    ordered(points, rank),
    (p) => p.x,
    (p) => -p.z,
    { ...size, north: true, label },
  );
}

/** The findings seen from the south: x east to the right, height up. */
export function sideView(
  points: readonly PlanPoint[],
  rank: ReadonlyMap<string, number>,
  label: string,
  size = { width: 340, height: 260 },
): string {
  return scatter(
    ordered(points, rank),
    (p) => p.x,
    (p) => p.y,
    { ...size, north: false, label },
  );
}
