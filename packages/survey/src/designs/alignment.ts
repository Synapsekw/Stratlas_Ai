import type { Alignment, AlignmentElement } from '@aio/schema';

/**
 * Horizontal alignments (`aio.alignment/1`, data-conventions section 28): point at a distance or
 * station, station and offset of a point, station equations and labels. The same arithmetic as
 * `aio_pipelines/design/alignment.py`, on the same fixtures (`__fixtures__/alignment-clothoid.json`).
 *
 * Bearings are radians clockwise from grid north; offsets are positive to the right of the
 * direction of travel. Clothoids integrate (sin, cos) of the bearing by 10-point Gauss-Legendre over
 * pieces of at most 5 m; the station of a point on a clothoid is found by bisection to 1e-10 m.
 * An equation `{ back, ahead }`: where the incoming chainage reaches `back`, stations continue from
 * `ahead`; the stretches between equations are regions 0, 1, ...
 */

type Elements = Pick<Alignment, 'elements' | 'equations' | 'startStation'> &
  Partial<Pick<Alignment, 'intervalM'>>;

const GL_X = [
  -0.9739065285171717, -0.8650633666889845, -0.6794095682990244, -0.4333953941292472,
  -0.1488743389816312, 0.1488743389816312, 0.4333953941292472, 0.6794095682990244,
  0.8650633666889845, 0.9739065285171717,
];
const GL_W = [
  0.0666713443086881, 0.1494513491505806, 0.219086362515982, 0.2692667193099963, 0.2955242247147529,
  0.2955242247147529, 0.2692667193099963, 0.219086362515982, 0.1494513491505806, 0.0666713443086881,
];
const PIECE_M = 5;
const EPS_S = 1e-9;
/** A foot this far past an end still counts (coordinates in files are rounded to 1e-6 m). */
const END_TOL = 1e-5;
const TAU = 2 * Math.PI;

const mod = (a: number, m: number) => ((a % m) + m) % m;

export function bearing(a: readonly [number, number], b: readonly [number, number]): number {
  return mod(Math.atan2(b[0] - a[0], b[1] - a[1]), TAU);
}

type Spiral = Extract<AlignmentElement, { type: 'spiral' }>;
const curv = (r: number | null) => (r === null ? 0 : 1 / r);
const sigma = (rot: 'cw' | 'ccw') => (rot === 'cw' ? 1 : -1);

function spiralBearing(el: Spiral, s: number): number {
  const k1 = curv(el.radiusStart);
  const k2 = curv(el.radiusEnd);
  return el.dirStart + sigma(el.rot) * (k1 * s + ((k2 - k1) * s * s) / (2 * el.length));
}

function spiralPoint(el: Spiral, s: number): [number, number] {
  const [e0, n0] = el.start;
  if (s <= 0) return [e0, n0];
  const pieces = Math.max(1, Math.ceil(s / PIECE_M));
  const h = s / pieces;
  let de = 0;
  let dn = 0;
  for (let k = 0; k < pieces; k++) {
    const a = k * h;
    for (let i = 0; i < GL_X.length; i++) {
      const t = a + (((GL_X[i] ?? 0) + 1) * h) / 2;
      const th = spiralBearing(el, t);
      de += (GL_W[i] ?? 0) * Math.sin(th);
      dn += (GL_W[i] ?? 0) * Math.cos(th);
    }
  }
  return [e0 + (de * h) / 2, n0 + (dn * h) / 2];
}

/** [E, N, bearing] at distance s along one element. */
export function elementPoint(el: AlignmentElement, s: number): [number, number, number] {
  if (el.type === 'line') {
    const [e0, n0] = el.start;
    const [e1, n1] = el.end;
    const len = Math.hypot(e1 - e0, n1 - n0);
    const f = len > 0 ? s / len : 0;
    return [e0 + (e1 - e0) * f, n0 + (n1 - n0) * f, bearing(el.start, el.end)];
  }
  if (el.type === 'arc') {
    const [ce, cn] = el.center;
    const [e0, n0] = el.start;
    const r = el.radius;
    const phi0 = Math.atan2(n0 - cn, e0 - ce);
    let phi: number;
    let te: number;
    let tn: number;
    if (el.rot === 'ccw') {
      phi = phi0 + s / r;
      te = -Math.sin(phi);
      tn = Math.cos(phi);
    } else {
      phi = phi0 - s / r;
      te = Math.sin(phi);
      tn = -Math.cos(phi);
    }
    return [ce + r * Math.cos(phi), cn + r * Math.sin(phi), mod(Math.atan2(te, tn), TAU)];
  }
  const [e, n] = spiralPoint(el, s);
  return [e, n, mod(spiralBearing(el, s), TAU)];
}

export function totalLength(al: Elements): number {
  return al.elements.reduce((sum, el) => sum + el.length, 0);
}

/** [E, N, bearing] at a distance from the start (clamped to the ends). */
export function pointAt(al: Elements, distance: number): [number, number, number] {
  let rest = Math.max(0, distance);
  for (const el of al.elements) {
    if (rest <= el.length) return elementPoint(el, rest);
    rest -= el.length;
  }
  const last = al.elements[al.elements.length - 1];
  if (!last) throw new RangeError('An alignment has no elements.');
  return elementPoint(last, last.length);
}

export interface StationRegion {
  index: number;
  start: number;
  end: number;
  station: number;
}

/** The station regions; throws a RangeError when an equation lies outside the alignment. */
export function stationRegions(al: Elements): StationRegion[] {
  const length = totalLength(al);
  const out: StationRegion[] = [];
  let s0 = 0;
  let st0 = al.startStation;
  al.equations.forEach((eq, i) => {
    const at = s0 + (eq.back - st0);
    if (at < s0 - EPS_S || at > length + EPS_S)
      throw new RangeError(
        `station equation ${i + 1} (back ${formatStation(eq.back)}) lies outside the alignment`,
      );
    out.push({ index: i, start: s0, end: at, station: st0 });
    s0 = at;
    st0 = eq.ahead;
  });
  out.push({ index: out.length, start: s0, end: length, station: st0 });
  return out;
}

/** [station, region] at a distance along the alignment. */
export function stationAt(al: Elements, distance: number): [number, number] {
  const regs = stationRegions(al);
  for (let i = 0; i < regs.length; i++) {
    const r = regs[i];
    if (r && (distance < r.end || i === regs.length - 1))
      return [r.station + (distance - r.start), r.index];
  }
  throw new Error('unreachable');
}

/** The distance of a station (in a region, or the first region that holds it); null if none. */
export function distanceAt(al: Elements, station: number, region?: number): number | null {
  for (const r of stationRegions(al)) {
    if (region !== undefined && r.index !== region) continue;
    const d = r.start + (station - r.station);
    if (d >= r.start - EPS_S && d <= r.end + EPS_S) return Math.min(Math.max(d, r.start), r.end);
  }
  return null;
}

export function pointAtStation(
  al: Elements,
  station: number,
  region?: number,
): [number, number, number] | null {
  const d = distanceAt(al, station, region);
  return d === null ? null : pointAt(al, d);
}

function footOnLine(el: Extract<AlignmentElement, { type: 'line' }>, e: number, n: number): number {
  const [e0, n0] = el.start;
  const de = el.end[0] - e0;
  const dn = el.end[1] - n0;
  const ll = de * de + dn * dn;
  return ll > 0 ? ((e - e0) * de + (n - n0) * dn) / Math.sqrt(ll) : 0;
}

function footOnArc(el: Extract<AlignmentElement, { type: 'arc' }>, e: number, n: number): number {
  const [ce, cn] = el.center;
  const phi0 = Math.atan2(el.start[1] - cn, el.start[0] - ce);
  const phi = Math.atan2(n - cn, e - ce);
  const turn = mod(el.rot === 'ccw' ? phi - phi0 : phi0 - phi, TAU);
  let s = turn * el.radius;
  if (s > el.length) {
    const before = TAU * el.radius - s;
    if (before < s - el.length) s = -before;
  }
  return s;
}

function footOnSpiral(el: Spiral, e: number, n: number): number[] {
  const f = (s: number) => {
    const [pe, pn, b] = elementPoint(el, s);
    return (e - pe) * Math.sin(b) + (n - pn) * Math.cos(b);
  };
  const samples = 64;
  const feet: number[] = [];
  let prevS = 0;
  let prevF = f(0);
  if (Math.abs(prevF) < 1e-12) feet.push(0);
  for (let k = 1; k <= samples; k++) {
    const s = (el.length * k) / samples;
    const fs = f(s);
    if (Math.abs(fs) < 1e-12) feet.push(s);
    else if (prevF * fs < 0) {
      let lo = prevS;
      let hi = s;
      let flo = prevF;
      for (let i = 0; i < 200 && hi - lo >= 1e-10; i++) {
        const mid = (lo + hi) / 2;
        const fm = f(mid);
        if (fm < 0 === flo < 0) {
          lo = mid;
          flo = fm;
        } else hi = mid;
      }
      feet.push((lo + hi) / 2);
    }
    prevS = s;
    prevF = fs;
  }
  return feet;
}

export interface StationOffset {
  station: number;
  /** Positive to the right of the direction of travel, metres. */
  offset: number;
  distance: number;
  region: number;
  element: number;
}

/** Station and offset of a point; null when its foot is off the alignment. */
export function stationOffset(al: Elements, e: number, n: number): StationOffset | null {
  let best: { d: number; dist: number; el: number } | null = null;
  let at = 0;
  al.elements.forEach((el, i) => {
    const feet =
      el.type === 'line'
        ? [footOnLine(el, e, n)]
        : el.type === 'arc'
          ? [footOnArc(el, e, n)]
          : footOnSpiral(el, e, n);
    for (const raw of feet) {
      if (raw < -END_TOL || raw > el.length + END_TOL) continue;
      const s = Math.min(Math.max(raw, 0), el.length);
      const [fe, fn] = elementPoint(el, s);
      const d = Math.hypot(e - fe, n - fn);
      if (best === null || d < best.d - 1e-12) best = { d, dist: at + s, el: i };
    }
    at += el.length;
  });
  const found = best as { d: number; dist: number; el: number } | null;
  if (found === null) return null;
  const [fe, fn, b] = pointAt(al, found.dist);
  const offset = Math.cos(b) * (e - fe) - Math.sin(b) * (n - fn);
  const [station, region] = stationAt(al, found.dist);
  return { station, offset, distance: found.dist, region, element: found.el };
}

/** `1+234.567`: thousands, a plus and the metres (negative stations keep their sign). */
export function formatStation(station: number, decimals = 3): string {
  const sign = station < 0 ? '-' : '';
  const p = 10 ** decimals;
  const v = Math.round(Math.abs(station) * p) / p;
  const km = Math.floor(v / 1000);
  const rest = (v - km * 1000).toFixed(decimals);
  const width = 3 + (decimals > 0 ? decimals + 1 : 0);
  return `${sign}${km}+${rest.padStart(width, '0')}`;
}

export interface StationLabel {
  distance: number;
  station: number;
  label: string;
  region: number;
}

/** Labels at every multiple of the interval (default the alignment's `intervalM`, else 20 m). */
export function stationLabels(al: Elements, interval?: number): StationLabel[] {
  const step = interval ?? al.intervalM ?? 20;
  const out: StationLabel[] = [];
  for (const r of stationRegions(al)) {
    const endStation = r.station + (r.end - r.start);
    for (let k = Math.ceil(r.station / step - 1e-9); k * step <= endStation + 1e-9; k++) {
      const st = k * step;
      out.push({
        distance: r.start + (st - r.station),
        station: st,
        label: formatStation(st, step >= 1 ? 0 : 2),
        region: r.index,
      });
    }
  }
  return out;
}

/** Points along the alignment every `stepM` (and at every element end), for drawing it. */
export function alignmentPolyline(al: Elements, stepM = 1): [number, number][] {
  const out: [number, number][] = [];
  for (const el of al.elements) {
    const pieces = el.type === 'line' ? 1 : Math.max(1, Math.ceil(el.length / stepM));
    for (let k = out.length ? 1 : 0; k <= pieces; k++) {
      const [e, n] = elementPoint(el, (el.length * k) / pieces);
      out.push([e, n]);
    }
  }
  return out;
}
