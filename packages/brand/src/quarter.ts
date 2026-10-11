/**
 * Geometry of the Quarter mark on the brand kit's 64 unit grid: three quarters of a ring and a
 * square tail, the fourth piece. Still drawings use the exact outlines (`quarterPieces`); motion
 * uses the sharp polygons (`quarterPolygons`), inset by the corner radius and drawn with a round
 * stroke of twice that radius, which gives the same shape. Angles are in degrees, clockwise from
 * the positive x axis (y points down). Pure functions; `.mjs` tools import this file directly.
 */

export type Pt = readonly [number, number];

export interface QuarterCut {
  /** Ring centre, x and y. */
  c: number;
  /** Each quarter is pushed this far from the centre on both axes. */
  gap: number;
  /** Inner and outer ring radius. */
  r0: number;
  r1: number;
  /** Corner radius of every piece. */
  corner: number;
  /** The tail: a square `size` wide, its top-left corner `offset` from the ring centre on both axes. */
  tail: { offset: number; size: number };
}

/** The mark (cut A1 of the 11 Oct 2026 board). */
export const QUARTER: QuarterCut = {
  c: 29,
  gap: 2,
  r0: 10.5,
  r1: 23,
  corner: 1.6,
  tail: { offset: 6, size: 21 },
};

/** 32 px and less: the three quarters close into one ring section, the tail sits a little off. */
export const QUARTER_SMALL: QuarterCut = {
  c: 28.5,
  gap: 0,
  r0: 8.5,
  r1: 24.5,
  corner: 1.2,
  tail: { offset: 7.5, size: 21 },
};

const n = (v: number) => String(+v.toFixed(2));
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Outline of a ring section from `a0` to `a1` with every corner rounded by `corner`. */
export function ringSection(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
  corner: number,
): string {
  const outer = r1 - corner;
  const inner = r0 + corner;
  const u0: Pt = [Math.cos(rad(a0)), Math.sin(rad(a0))];
  const u1: Pt = [Math.cos(rad(a1)), Math.sin(rad(a1))];
  // normals of the two straight edges, pointing into the section
  const n0: Pt = [-u0[1], u0[0]];
  const n1: Pt = [u1[1], -u1[0]];
  /** Centre of the corner circle where the edge along `u` meets the arc of radius `r`. */
  const centre = (u: Pt, inward: Pt, r: number): Pt => {
    const t = Math.sqrt(r * r - corner * corner);
    return [cx + u[0] * t + inward[0] * corner, cy + u[1] * t + inward[1] * corner];
  };
  const move = (p: Pt, v: Pt, k: number): Pt => [p[0] + v[0] * k, p[1] + v[1] * k];
  const radial = (p: Pt, r: number): Pt => [(p[0] - cx) / r, (p[1] - cy) / r];
  const a = centre(u0, n0, outer);
  const b = centre(u1, n1, outer);
  const c = centre(u1, n1, inner);
  const d = centre(u0, n0, inner);
  const at = (p: Pt) => `${n(p[0])} ${n(p[1])}`;
  const fillet = `A${n(corner)} ${n(corner)} 0 0 1 `;
  const large = a1 - a0 > 180 ? 1 : 0;
  return (
    `M${at(move(a, radial(a, outer), corner))}` +
    `A${n(r1)} ${n(r1)} 0 ${String(large)} 1 ${at(move(b, radial(b, outer), corner))}` +
    fillet +
    at(move(b, n1, -corner)) +
    `L${at(move(c, n1, -corner))}` +
    fillet +
    at(move(c, radial(c, inner), -corner)) +
    `A${n(r0)} ${n(r0)} 0 ${String(large)} 0 ${at(move(d, radial(d, inner), -corner))}` +
    fillet +
    at(move(d, n0, -corner)) +
    `L${at(move(a, n0, -corner))}` +
    fillet +
    at(move(a, radial(a, outer), corner)) +
    'Z'
  );
}

/** Outline of a square with rounded corners. */
export function roundSquare(x: number, y: number, size: number, corner: number): string {
  const r = `A${n(corner)} ${n(corner)} 0 0 1 `;
  const x1 = x + size;
  const y1 = y + size;
  return (
    `M${n(x + corner)} ${n(y)}H${n(x1 - corner)}${r}${n(x1)} ${n(y + corner)}` +
    `V${n(y1 - corner)}${r}${n(x1 - corner)} ${n(y1)}` +
    `H${n(x + corner)}${r}${n(x)} ${n(y1 - corner)}` +
    `V${n(y + corner)}${r}${n(x + corner)} ${n(y)}Z`
  );
}

/** Where each quarter's own centre sits and the angles it spans: north-west, north-east, south-west. */
const QUARTERS: readonly (readonly [number, number, number, number])[] = [
  [-1, -1, 180, 270],
  [1, -1, 270, 360],
  [-1, 1, 90, 180],
];

/** The mark as four outlines: three quarters, then the tail. */
export function quarterPieces(
  cut: QuarterCut = QUARTER,
): readonly [string, string, string, string] {
  const q = QUARTERS.map(([sx, sy, a0, a1]) =>
    ringSection(cut.c + sx * cut.gap, cut.c + sy * cut.gap, cut.r0, cut.r1, a0, a1, cut.corner),
  );
  const t = cut.c + cut.tail.offset;
  return [q[0] ?? '', q[1] ?? '', q[2] ?? '', roundSquare(t, t, cut.tail.size, cut.corner)];
}

/** The small cut as two outlines: the ring section, then the tail. */
export function quarterSmallPieces(cut: QuarterCut = QUARTER_SMALL): readonly [string, string] {
  const t = cut.c + cut.tail.offset;
  return [
    ringSection(cut.c, cut.c, cut.r0, cut.r1, 90, 360, cut.corner),
    roundSquare(t, t, cut.tail.size, cut.corner),
  ];
}

/** The square the mark occupies. */
export function quarterBounds(cut: QuarterCut): { x: number; y: number; w: number; h: number } {
  const min = cut.c - cut.gap - cut.r1;
  const size = cut.c + cut.tail.offset + cut.tail.size - min;
  return { x: min, y: min, w: size, h: size };
}

/** A ring section (a pie slice when `r0` is 0) as a sharp polygon, clockwise on screen. */
export function sectorPolygon(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
  steps = 12,
): Pt[] {
  const at = (r: number, i: number): Pt => {
    const a = rad(a0 + ((a1 - a0) * i) / steps);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) out.push(at(r1, i));
  if (r0 > 0) for (let i = steps; i >= 0; i--) out.push(at(r0, i));
  else out.push([cx, cy]);
  return out;
}

const quarterPolygon = (cut: QuarterCut, i: number): Pt[] => {
  const [sx, sy, a0, a1] = QUARTERS[i] ?? [0, 0, 0, 0];
  return sectorPolygon(cut.c + sx * cut.gap, cut.c + sy * cut.gap, cut.r0, cut.r1, a0, a1);
};

/** The mark as four sharp polygons in piece order (inset them by `corner` before stroking). */
export function quarterPolygons(cut: QuarterCut = QUARTER): Pt[][] {
  const t = cut.c + cut.tail.offset;
  const s = cut.tail.size;
  return [
    quarterPolygon(cut, 0),
    quarterPolygon(cut, 1),
    quarterPolygon(cut, 2),
    [
      [t, t],
      [t + s, t],
      [t + s, t + s],
      [t, t + s],
    ],
  ];
}

/** The closed ring the Step out motion starts from: the fourth piece is the south-east quarter. */
export function ringPolygons(cut: QuarterCut = QUARTER): Pt[][] {
  return [
    quarterPolygon(cut, 0),
    quarterPolygon(cut, 1),
    quarterPolygon(cut, 2),
    sectorPolygon(cut.c + cut.gap, cut.c + cut.gap, cut.r0, cut.r1, 0, 90),
  ];
}
