/**
 * The opened pile in 3D (founder, 26 Oct 2026: the "glass box" look): the pile's surface lifted
 * above the ground in solid red, hillshaded so the relief reads, or coloured by its height above
 * the base; a translucent blue base on the base surface, clipped to the boundary; a white frame,
 * the boundary at the top and at the ground with a thin post at each vertex. The terrain around it
 * is left as it is.
 *
 * Pure: site points (E, N, Z) in, site points and colours out. `pileLookScene` samples the
 * heights, builds the base and draws what this returns.
 */
import type { SitePoint } from '@aio/schema';
import type { ScreenPt } from '@aio/survey';
import { ShapeUtils, Vector2 } from 'three';
import type { HitShape } from '../measureHits';

/** How the opened pile's top is coloured: solid red, or its height above the base. */
export type PileSurfaceMode = 'solid' | 'height';

/** A colour, each channel 0 to 1 (sRGB). */
export type RGB = [number, number, number];

/** The sample grid over a pile's boundary box, in site metres. */
export interface PileGrid {
  minE: number;
  minN: number;
  maxE: number;
  maxN: number;
  step: number;
  nx: number;
  ny: number;
  /** The box's longer side (at least 5 m). */
  span: number;
}

/** About this many cells across the pile's longer side. */
export const GRID_CELLS = 110;

/** The grid over a boundary: `cells` steps across its longer side. */
export function pileGrid(ring: readonly SitePoint[], cells = GRID_CELLS): PileGrid {
  const es = ring.map((p) => p[0]);
  const ns = ring.map((p) => p[1]);
  const minE = Math.min(...es);
  const maxE = Math.max(...es);
  const minN = Math.min(...ns);
  const maxN = Math.max(...ns);
  const span = Math.max(maxE - minE, maxN - minN, 5);
  const step = span / cells;
  return {
    minE,
    minN,
    maxE,
    maxN,
    step,
    nx: Math.ceil((maxE - minE) / step) + 1,
    ny: Math.ceil((maxN - minN) / step) + 1,
    span,
  };
}

/** The grid's sample points, row by row from the south-west corner. */
export function gridPoints(g: PileGrid): { es: Float64Array; ns: Float64Array } {
  const es = new Float64Array(g.nx * g.ny);
  const ns = new Float64Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++)
    for (let i = 0; i < g.nx; i++) {
      es[j * g.nx + i] = g.minE + i * g.step;
      ns[j * g.nx + i] = g.minN + j * g.step;
    }
  return { es, ns };
}

/** Whether (e, n) lies inside the ring (even-odd). */
export function insideRing(e: number, n: number, ring: readonly SitePoint[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a[1] > n !== b[1] > n && e < ((b[0] - a[0]) * (n - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/**
 * The boundary's own heights, triangulated: the base to stand on when the pile's base cannot be
 * built (no survey under its edge yet). Null outside the boundary.
 */
export function ringBase(ring: readonly SitePoint[]): (e: number, n: number) => number | null {
  const tris = ShapeUtils.triangulateShape(
    ring.map((p) => new Vector2(p[0], p[1])),
    [],
  );
  return (e, n) => {
    for (const [i, j, k] of tris) {
      const a = ring[i ?? -1];
      const b = ring[j ?? -1];
      const c = ring[k ?? -1];
      if (!a || !b || !c) continue;
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (d === 0) continue;
      const l1 = ((b[1] - c[1]) * (e - c[0]) + (c[0] - b[0]) * (n - c[1])) / d;
      const l2 = ((c[1] - a[1]) * (e - c[0]) + (a[0] - c[0]) * (n - c[1])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return l1 * a[2] + l2 * b[2] + l3 * c[2];
    }
    return null;
  };
}

/** How far the pile is lifted above the ground: well clear of its own height and of its size. */
export function pileLift(hmax: number, span: number): number {
  return Math.max(hmax * 1.6, span * 0.22);
}

/** The height ramp, low to high: blue, cyan, green, yellow, red. */
export const HEIGHT_RAMP: readonly RGB[] = [
  [0.16, 0.32, 0.95],
  [0.1, 0.75, 0.9],
  [0.2, 0.8, 0.3],
  [0.98, 0.88, 0.15],
  [0.93, 0.15, 0.13],
];

/** The ramp's colour at `t` (0 the base, 1 the highest point), clamped. */
export function heightRamp(t: number): RGB {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (HEIGHT_RAMP.length - 1);
  const i = Math.min(HEIGHT_RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = HEIGHT_RAMP[i] ?? [0, 0, 0];
  const b = HEIGHT_RAMP[i + 1] ?? [0, 0, 0];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** The legend's marks: the base, half way and the highest point above it, in metres. */
export function legendStops(hmax: number): [number, number, number] {
  const top = Math.max(0, hmax);
  return [0, top / 2, top];
}

/** The solid top's red (sRGB) before shading. */
export const PILE_RED: RGB = [0.96, 0.13, 0.11];
/** A cell the cut and fill colours leave clear (inside the deadband). */
const CHANGE_CLEAR: RGB = [0.86, 0.86, 0.84];

export interface PrismInput {
  /** The boundary as drawn (site E, N, Z). */
  ring: readonly SitePoint[];
  grid: PileGrid;
  /** The terrain at the grid's points (`gridPoints`), NaN where there is none. */
  zs: ArrayLike<number>;
  /** The base under (e, n), null where it has none. */
  base: (e: number, n: number) => number | null;
  mode: PileSurfaceMode;
  /**
   * Change mode: the cut and fill colour at (e, n), null inside the deadband; absent or null
   * outside change mode. It takes the place of the solid red or the height ramp.
   */
  change?: ((e: number, n: number) => RGB | null) | null;
}

/** An indexed surface: site positions (E, N, Z) and, for the top, linear vertex colours. */
export interface PrismSurface {
  positions: Float64Array;
  colours: Float32Array | null;
  index: Uint32Array;
}

export interface Prism {
  /** How far the top is lifted, metres. */
  lift: number;
  /** The highest point above the base, metres (at least 0.5). */
  hmax: number;
  /** The ground at the middle of the boundary's box. */
  centre: SitePoint;
  span: number;
  /** The pile's surface, lifted. */
  top: PrismSurface;
  /** The base surface inside the boundary. */
  base: PrismSurface;
  /** The boundary at the ground and at the top, densified (closed loops, first point not repeated). */
  bottomLoop: SitePoint[];
  topLoop: SitePoint[];
  /** One post per boundary vertex, from the ground to the top. */
  posts: [SitePoint, SitePoint][];
  /** The ring's vertices on the ground (their terrain height). */
  groundRing: SitePoint[];
}

/** The light for the hillshade: from the west-south-west, high (the side the camera comes from). */
const LIGHT = (() => {
  const l = [-0.45, -0.25, 0.86];
  const n = Math.hypot(l[0] ?? 0, l[1] ?? 0, l[2] ?? 0);
  return l.map((v) => v / n) as [number, number, number];
})();

/** sRGB to linear (vertex colours are linear). */
const lin = (v: number) => Math.pow(Math.max(0, Math.min(1, v)), 2.2);

/** A loop's segments as pairs: [a0, a1, a1, a2, ...] for a closed loop. */
export function loopSegments(loop: readonly SitePoint[]): SitePoint[] {
  const out: SitePoint[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    if (a && b) out.push(a, b);
  }
  return out;
}

/** Build the opened pile's prism from the sampled terrain and its base. */
export function buildPrism(inp: PrismInput): Prism {
  const { ring, grid: g, zs, base } = inp;
  const { nx, ny, step, minE, minN } = g;
  const meanZ = ring.reduce((a, p) => a + p[2], 0) / Math.max(1, ring.length);
  const zAt = (i: number, j: number): number => {
    const ci = Math.max(0, Math.min(nx - 1, i));
    const cj = Math.max(0, Math.min(ny - 1, j));
    const z = zs[cj * nx + ci] ?? Number.NaN;
    if (Number.isFinite(z)) return z;
    return base(minE + ci * step, minN + cj * step) ?? meanZ;
  };
  const groundZ = (e: number, n: number): number => {
    const fi = (e - minE) / step;
    const fj = (n - minN) / step;
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const a = fi - i;
    const b = fj - j;
    return (
      zAt(i, j) * (1 - a) * (1 - b) +
      zAt(i + 1, j) * a * (1 - b) +
      zAt(i, j + 1) * (1 - a) * b +
      zAt(i + 1, j + 1) * a * b
    );
  };
  const baseAt = (i: number, j: number): number =>
    base(minE + i * step, minN + j * step) ?? zAt(i, j);

  // the highest point above the base, inside the boundary
  let hmax = 0.5;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const e = minE + i * step;
      const n = minN + j * step;
      if (!insideRing(e, n, ring)) continue;
      const b = base(e, n);
      if (b !== null) hmax = Math.max(hmax, zAt(i, j) - b);
    }
  const lift = pileLift(hmax, g.span);

  // the grid's cells whose middle lies inside the boundary, two triangles each
  const idx: number[] = [];
  for (let j = 0; j + 1 < ny; j++)
    for (let i = 0; i + 1 < nx; i++) {
      if (!insideRing(minE + (i + 0.5) * step, minN + (j + 0.5) * step, ring)) continue;
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const index = Uint32Array.from(idx);

  const top = new Float64Array(nx * ny * 3);
  const colours = new Float32Array(nx * ny * 3);
  const bottom = new Float64Array(nx * ny * 3);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const e = minE + i * step;
      const n = minN + j * step;
      const z = zAt(i, j);
      const k = (j * nx + i) * 3;
      top[k] = e;
      top[k + 1] = n;
      top[k + 2] = z + lift;
      bottom[k] = e;
      bottom[k + 1] = n;
      bottom[k + 2] = baseAt(i, j) + 0.03;
      // the normal from the grid, the slopes steepened for the shading only
      const dzde = ((zAt(i + 1, j) - zAt(i - 1, j)) / (2 * step)) * 3;
      const dzdn = ((zAt(i, j + 1) - zAt(i, j - 1)) / (2 * step)) * 3;
      const nl = Math.hypot(dzde, dzdn, 1);
      const dot = (-dzde * LIGHT[0] - dzdn * LIGHT[1] + LIGHT[2]) / nl;
      const shade = 0.42 + 0.62 * Math.max(0, dot);
      let rgb: RGB;
      let k2 = shade;
      if (inp.change) {
        rgb = inp.change(e, n) ?? CHANGE_CLEAR;
        k2 = 0.55 + 0.45 * shade;
      } else if (inp.mode === 'height') {
        rgb = heightRamp((z - baseAt(i, j)) / hmax);
        k2 = 0.55 + 0.45 * shade;
      } else rgb = PILE_RED;
      colours[k] = lin(rgb[0] * k2);
      colours[k + 1] = lin(rgb[1] * k2);
      colours[k + 2] = lin(rgb[2] * k2);
    }

  // the boundary, densified so it follows the ground between the vertices
  const flat: [number, number][] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (!a || !b) continue;
    const parts = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (step * 0.75)));
    for (let q = 0; q < parts; q++)
      flat.push([a[0] + ((b[0] - a[0]) * q) / parts, a[1] + ((b[1] - a[1]) * q) / parts]);
  }
  const bottomLoop = flat.map(([e, n]): SitePoint => [e, n, groundZ(e, n) + 0.06]);
  const topLoop = flat.map(([e, n]): SitePoint => [e, n, groundZ(e, n) + lift]);
  const groundRing = ring.map((p): SitePoint => [p[0], p[1], groundZ(p[0], p[1])]);
  const posts = groundRing.map((p): [SitePoint, SitePoint] => [p, [p[0], p[1], p[2] + lift]]);
  const ce = (g.minE + g.maxE) / 2;
  const cn = (g.minN + g.maxN) / 2;
  return {
    lift,
    hmax,
    centre: [ce, cn, groundZ(ce, cn)],
    span: g.span,
    top: { positions: top, colours, index },
    base: { positions: bottom, colours: null, index },
    bottomLoop,
    topLoop,
    posts,
    groundRing,
  };
}

/**
 * What a click or a right-click takes for the opened pile besides its outline on the ground: the
 * lifted top and each side of the box.
 */
export function prismHitShapes(id: string, p: Pick<Prism, 'groundRing' | 'lift'>): HitShape[] {
  const up = (q: SitePoint): SitePoint => [q[0], q[1], q[2] + p.lift];
  const out: HitShape[] = [{ id, points: p.groundRing.map(up), closed: true }];
  const n = p.groundRing.length;
  for (let k = 0; k < n; k++) {
    const a = p.groundRing[k];
    const b = p.groundRing[(k + 1) % n];
    if (a && b) out.push({ id, points: [a, b, up(b), up(a)], closed: true });
  }
  return out;
}

/** The camera for an opened pile: where it looks, from how far and from which side. */
export interface PileFlyView {
  /** The point looked at (site). */
  at: SitePoint;
  distance: number;
  /** From the point towards the camera (site E, N, Z; unit length). */
  dir: SitePoint;
}

/**
 * How far a camera with a vertical field of view of `vfovDeg` and the view's `aspect` (width over
 * height) stands for a sphere of `radius` to fill the narrower of its two angles.
 */
export function fitDistance(radius: number, vfovDeg: number, aspect: number): number {
  const v = (vfovDeg * Math.PI) / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * Math.max(0.05, aspect));
  return radius / Math.sin(Math.min(v, h) / 2);
}

/**
 * An oblique view framing the whole box: looking down at `elevationDeg` from the
 * south-south-west (`azimuthDeg` clockwise from north), at the box's middle. With the camera's
 * field of view the box's bounding sphere fits the view (a narrow view stands further back);
 * without it, twice the pile's size.
 */
export function pileFlyView(
  p: Pick<Prism, 'centre' | 'lift' | 'span'>,
  opts: { elevationDeg?: number; azimuthDeg?: number; vfovDeg?: number; aspect?: number } = {},
): PileFlyView {
  const el = ((opts.elevationDeg ?? 38) * Math.PI) / 180;
  const az = ((opts.azimuthDeg ?? 200) * Math.PI) / 180;
  const radius = 0.5 * Math.hypot(p.span, p.span, p.lift);
  const distance =
    opts.vfovDeg !== undefined && opts.aspect !== undefined
      ? fitDistance(radius, opts.vfovDeg, opts.aspect) * 1.05
      : p.span * 2 + p.lift;
  return {
    at: [p.centre[0], p.centre[1], p.centre[2] + p.lift * 0.45],
    distance,
    dir: [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)],
  };
}

/**
 * Whether a pile is already mostly in view: at least `share` of its corner points are on the
 * screen (`w` by `h`, from 0) and it is at least `minPx` across. Points behind the camera are null.
 */
export function mostlyInView(
  pts: readonly (ScreenPt | null)[],
  w: number,
  h: number,
  share = 0.75,
  minPx = 60,
): boolean {
  if (pts.length === 0) return false;
  let on = 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (!p) continue;
    if (p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h) on++;
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  return on / pts.length >= share && Math.max(x1 - x0, y1 - y0) >= minPx;
}
