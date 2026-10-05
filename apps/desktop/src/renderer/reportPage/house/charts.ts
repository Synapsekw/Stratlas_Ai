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
  opts: {
    width: number;
    height: number;
    north: boolean;
    label: string;
    /** Fixed extent (a locator around one issue); the points' bounds otherwise. */
    box?: Box;
    /** The issue the drawing is about, drawn large on top. */
    focus?: PlanPoint;
    /** Extra class on the SVG (`loc`: the dark locator map). */
    cls?: string;
  },
): string {
  const { width, height } = opts;
  const margin = 18;
  const box = opts.box ?? bounds(points, a, b);
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
  const r = opts.focus ? 3 : Math.max(1.6, Math.min(4.5, 900 / Math.max(1, points.length) ** 0.75));
  const dots = points
    .map(
      (p) =>
        `<circle cx="${X(a(p)).toFixed(1)}" cy="${Y(b(p)).toFixed(1)}" r="${r.toFixed(1)}" fill="${esc(p.color)}" stroke="#ffffff" stroke-width="0.6"${opts.focus ? ' opacity="0.55"' : ''}/>`,
    )
    .join('');
  const f = opts.focus;
  const focus = f
    ? `<circle cx="${X(a(f)).toFixed(1)}" cy="${Y(b(f)).toFixed(1)}" r="7" fill="${esc(f.color)}" stroke="${opts.cls === 'loc' ? '#ffffff' : '#16202b'}" stroke-width="1.5"/><circle cx="${X(a(f)).toFixed(1)}" cy="${Y(b(f)).toFixed(1)}" r="13" fill="none" stroke="${esc(f.color)}" stroke-width="2"/>`
    : '';
  // scale bar: a nice length near a quarter of the drawing
  const step = niceStep((box.maxA - box.minA) / 4);
  const sx = ox;
  const sy = height - 6;
  const scale = `<g class="scale"><line x1="${sx.toFixed(1)}" y1="${sy}" x2="${(sx + step * k).toFixed(1)}" y2="${sy}"/><line x1="${sx.toFixed(1)}" y1="${sy - 3}" x2="${sx.toFixed(1)}" y2="${sy + 1}"/><line x1="${(sx + step * k).toFixed(1)}" y1="${sy - 3}" x2="${(sx + step * k).toFixed(1)}" y2="${sy + 1}"/><text x="${(sx + step * k + 4).toFixed(1)}" y="${sy + 3}">${esc(String(step))} m</text></g>`;
  const north = opts.north
    ? `<g class="north" transform="translate(${(width - 14).toFixed(1)},16)"><path d="M0,-10 L5,6 L0,3 L-5,6 Z"/><text y="18" text-anchor="middle">N</text></g>`
    : '';
  const frame = `<rect class="frame" x="${ox.toFixed(1)}" y="${oy.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`;
  return `<svg class="map${opts.cls ? ` ${opts.cls}` : ''}" viewBox="0 0 ${String(width)} ${String(height)}" width="100%" role="img" aria-label="${esc(opts.label)}">${frame}${dots}${focus}${scale}${north}</svg>`;
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

/** Are the points flat (a road, a yard), so a side view says nothing? */
export function isFlat(points: readonly PlanPoint[]): boolean {
  if (points.every((p) => p.map)) return true;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    lo = Math.min(lo, p.y);
    hi = Math.max(hi, p.y);
  }
  const xs = points.map((p) => p.x);
  const zs = points.map((p) => p.z);
  const w = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  return hi - lo < Math.max(2, w * 0.05);
}

/**
 * Where one issue lies among its neighbours, from above: a square `spanM` metres wide centred on
 * it, north up, with a scale bar. For issues placed on the map only (no 3D view). Drawn dark, like
 * every map in the app (class `loc`, house.css).
 */
export function locatorMap(
  points: readonly PlanPoint[],
  focus: PlanPoint,
  rank: ReadonlyMap<string, number>,
  label: string,
  spanM = 120,
  size = { width: 360, height: 270 },
): string {
  const half = spanM / 2;
  const aspect = (size.height - 14) / size.width;
  const box: Box = {
    minA: focus.x - half,
    maxA: focus.x + half,
    minB: -focus.z - half * aspect,
    maxB: -focus.z + half * aspect,
  };
  const near = points.filter(
    (p) =>
      p.id !== focus.id &&
      p.x >= box.minA &&
      p.x <= box.maxA &&
      -p.z >= box.minB &&
      -p.z <= box.maxB,
  );
  return scatter(
    ordered(near, rank),
    (p) => p.x,
    (p) => -p.z,
    { ...size, north: true, label, box, focus, cls: 'loc' },
  );
}

/** The stockpiles from above: each toe line with the pile's name, north up, with a scale bar. */
export function pileMap(
  piles: readonly { name: string; outline: [number, number][] | null }[],
  label: string,
  size = { width: 688, height: 380 },
): string {
  const shapes = piles.filter(
    (p): p is { name: string; outline: [number, number][] } => (p.outline?.length ?? 0) >= 3,
  );
  if (shapes.length === 0) return '';
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (const p of shapes)
    for (const [x, z] of p.outline) {
      minA = Math.min(minA, x);
      maxA = Math.max(maxA, x);
      minB = Math.min(minB, -z);
      maxB = Math.max(maxB, -z);
    }
  const margin = 16;
  const { width, height } = size;
  const k = Math.min(
    (width - 2 * margin) / (maxA - minA || 1),
    (height - 2 * margin - 14) / (maxB - minB || 1),
  );
  const ox = (width - (maxA - minA) * k) / 2;
  const oy = (height - 14 - (maxB - minB) * k) / 2;
  const X = (x: number) => ox + (x - minA) * k;
  const Y = (b: number) => oy + (maxB - b) * k;
  const polys = shapes
    .map((p) => {
      const d =
        p.outline
          .map(([x, z], i) => `${i === 0 ? 'M' : 'L'}${X(x).toFixed(1)},${Y(-z).toFixed(1)}`)
          .join('') + 'Z';
      const cx = p.outline.reduce((s2, [x]) => s2 + x, 0) / p.outline.length;
      const cz = p.outline.reduce((s2, [, z]) => s2 + z, 0) / p.outline.length;
      return `<path class="pile" d="${d}"/><text class="pl" x="${X(cx).toFixed(1)}" y="${(Y(-cz) + 3).toFixed(1)}" text-anchor="middle">${esc(p.name.replace(/^Pile\s+/i, ''))}</text>`;
    })
    .join('');
  const step = niceStep((maxA - minA) / 5);
  const sy = height - 6;
  const scale = `<g class="scale"><line x1="${ox.toFixed(1)}" y1="${sy}" x2="${(ox + step * k).toFixed(1)}" y2="${sy}"/><text x="${(ox + step * k + 4).toFixed(1)}" y="${sy + 3}">${esc(String(step))} m</text></g>`;
  const north = `<g class="north" transform="translate(${(width - 14).toFixed(1)},16)"><path d="M0,-10 L5,6 L0,3 L-5,6 Z"/><text y="18" text-anchor="middle">N</text></g>`;
  return `<svg class="map" viewBox="0 0 ${String(width)} ${String(height)}" width="100%" role="img" aria-label="${esc(label)}">${polys}${scale}${north}</svg>`;
}
