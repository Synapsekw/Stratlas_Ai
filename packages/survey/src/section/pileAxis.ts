/**
 * The long axis of a pile: the line the pile panel's profile is cut along by default.
 *
 * Angles are degrees clockwise from east (site E, N), kept in [0, 180) since a line has no
 * direction. The default angle is the principal axis of the footprint's second moments of area
 * about its area centroid; the ends are the ring's extent along that axis plus a margin of the
 * length on each side, so the profile starts and ends on the ground beside the pile.
 */
import type { SitePoint } from '@aio/schema';

export interface PileAxis {
  a: [number, number];
  b: [number, number];
  centre: [number, number];
  /** Degrees clockwise from east, in [0, 180). */
  angleDeg: number;
  lengthM: number;
}

type Ring = readonly (SitePoint | readonly [number, number])[];

const DEFAULT_MARGIN_PCT = 5;
const DEG = Math.PI / 180;

function normaliseDeg(deg: number): number {
  const a = ((deg % 180) + 180) % 180;
  return a > 180 - 1e-9 ? 0 : a;
}

/** Area centroid and central second moments of the ring; vertex averages when it has no area. */
function moments(ring: Ring): { cx: number; cy: number; sxx: number; syy: number; sxy: number } {
  const n = ring.length;
  if (n === 0) return { cx: 0, cy: 0, sxx: 0, syy: 0, sxy: 0 };
  // shift to the first vertex for precision with large site coordinates
  const ox = ring[0]?.[0] ?? 0;
  const oy = ring[0]?.[1] ?? 0;
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  let ixx = 0;
  let iyy = 0;
  let ixy = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    if (!p || !q) continue;
    const x0 = p[0] - ox;
    const y0 = p[1] - oy;
    const x1 = q[0] - ox;
    const y1 = q[1] - oy;
    const c = x0 * y1 - x1 * y0;
    a2 += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
    ixx += (x0 * x0 + x0 * x1 + x1 * x1) * c; // ∫x² · 12
    iyy += (y0 * y0 + y0 * y1 + y1 * y1) * c; // ∫y² · 12
    ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * c; // ∫xy · 24
  }
  const area = a2 / 2;
  if (Math.abs(area) < 1e-12) {
    let mx = 0;
    let my = 0;
    for (const p of ring) {
      mx += p[0] - ox;
      my += p[1] - oy;
    }
    mx /= n;
    my /= n;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of ring) {
      const dx = p[0] - ox - mx;
      const dy = p[1] - oy - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    return { cx: mx + ox, cy: my + oy, sxx, syy, sxy };
  }
  const gx = cx / (6 * area);
  const gy = cy / (6 * area);
  // the signs cancel when the ring runs clockwise: every moment and the area flip together
  const sxx = ixx / 12 / area - gx * gx;
  const syy = iyy / 12 / area - gy * gy;
  const sxy = ixy / 24 / area - gx * gy;
  return { cx: gx + ox, cy: gy + oy, sxx, syy, sxy };
}

function principalDeg(m: { sxx: number; syy: number; sxy: number }): number {
  const diff = m.sxx - m.syy;
  const scale = Math.abs(m.sxx) + Math.abs(m.syy);
  // a square or a circle has no long axis: keep east so the line does not jitter
  if (scale === 0 || (Math.abs(diff) <= 1e-9 * scale && Math.abs(m.sxy) <= 1e-9 * scale)) return 0;
  const ccw = 0.5 * Math.atan2(2 * m.sxy, diff);
  return normaliseDeg(-ccw / DEG);
}

function axisThrough(
  ring: Ring,
  centre: readonly [number, number],
  angleDeg: number,
  marginPct: number,
): PileAxis {
  const ux = Math.cos(angleDeg * DEG);
  const uy = -Math.sin(angleDeg * DEG);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const t = (p[0] - centre[0]) * ux + (p[1] - centre[1]) * uy;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) lo = hi = 0;
  const pad = ((hi - lo) * marginPct) / 100;
  const t0 = lo - pad;
  const t1 = hi + pad;
  return {
    a: [centre[0] + ux * t0, centre[1] + uy * t0],
    b: [centre[0] + ux * t1, centre[1] + uy * t1],
    centre: [centre[0], centre[1]],
    angleDeg,
    lengthM: t1 - t0,
  };
}

/** The long axis of a pile's footprint, or the line at `angleDeg` through its centroid. */
export function pileAxis(
  ring: readonly SitePoint[],
  opts: { angleDeg?: number; marginPct?: number } = {},
): PileAxis {
  const m = moments(ring);
  const angle = opts.angleDeg === undefined ? principalDeg(m) : normaliseDeg(opts.angleDeg);
  return axisThrough(ring, [m.cx, m.cy], angle, opts.marginPct ?? DEFAULT_MARGIN_PCT);
}

/** The axis turned by `deltaDeg` (clockwise) about its centre, its ends refitted to the ring. */
export function rotateAxis(axis: PileAxis, ring: readonly SitePoint[], deltaDeg: number): PileAxis {
  return axisThrough(ring, axis.centre, normaliseDeg(axis.angleDeg + deltaDeg), DEFAULT_MARGIN_PCT);
}

/** One end dragged to `p`; the other end stays, the centre is the new midpoint. */
export function moveAxisEnd(
  axis: PileAxis,
  end: 'a' | 'b',
  p: readonly [number, number],
): PileAxis {
  const a: [number, number] = end === 'a' ? [p[0], p[1]] : [axis.a[0], axis.a[1]];
  const b: [number, number] = end === 'b' ? [p[0], p[1]] : [axis.b[0], axis.b[1]];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthM = Math.hypot(dx, dy);
  const angleDeg = lengthM === 0 ? axis.angleDeg : normaliseDeg(Math.atan2(-dy, dx) / DEG);
  return { a, b, centre: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], angleDeg, lengthM };
}
