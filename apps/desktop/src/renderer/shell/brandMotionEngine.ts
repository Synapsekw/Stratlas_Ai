/**
 * The motion engine of the Quarter mark: the four pieces (north-west, north-east, south-west, the
 * tail) as polygons of one fixed point count, so any pose can blend into any other point by
 * point. Polygons are inset by the corner radius and drawn with a round stroke of twice that
 * radius (`STROKE`), which rounds the corners the way the still mark has them. Pure functions of
 * time, no DOM: `BrandMotion.tsx` draws the frames.
 *
 * The file is not called `brandMotion.ts` on purpose: on Windows and macOS an import of
 * `./BrandMotion` would find that file before `BrandMotion.tsx`.
 */
import { QUARTER, quarterPolygons, ringPolygons, sectorPolygon, type Pt } from '@aio/brand';

export type MotionName = 'stepOut' | 'turns' | 'sequence';

/** One form the four pieces can take. */
export interface Pose {
  label: string;
  /** Turn of the whole mark about the ring centre, in degrees. */
  rot: number;
  /** Width of the ground coloured rim around every piece (the model form lifts its plate). */
  halo: number;
  opacity: readonly number[];
  /** `POINTS` points per piece, in piece order. */
  pts: readonly (readonly Pt[])[];
}

export interface Motion {
  name: MotionName;
  poses: readonly Pose[];
  /** The mark itself: where a motion that is not `fromFirst` starts. */
  rest: Pose;
  /** How long a `fromFirst` motion holds its first pose before it moves. */
  lead: number;
  /** How long one piece takes from pose to pose. */
  move: number;
  /** Each piece starts this much later than the one before it. */
  stagger: number;
  /** The pause on a pose before the next transition. */
  hold: number;
  /** Every transition overshoots and settles. */
  back: boolean;
  /** The last pose looks like the rest pose, so the motion can run on without a seam. */
  loops: boolean;
  /** Starts on `poses[0]` instead of the rest pose. */
  fromFirst: boolean;
}

/** One piece at one moment. Pieces start one after another, so mid-move each has its own values. */
export interface PieceFrame {
  d: string;
  opacity: number;
  rot: number;
  halo: number;
}

/** Points per piece in every pose. */
export const POINTS = 48;
/** Stroke width that puts back what the inset took. */
export const STROKE = 2 * QUARTER.corner;

const PIECES = 4;
const ORIGIN: Pt = [0, 0];
/** The vertex at `i`, counting round the polygon in both directions. */
const vertex = (p: readonly Pt[], i: number): Pt =>
  p[((i % p.length) + p.length) % p.length] ?? ORIGIN;

/** Shoelace area: positive when the polygon runs clockwise on screen (y points down). */
function area(p: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = vertex(p, i);
    const [x1, y1] = vertex(p, i + 1);
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Move every edge of a polygon inward by `r`. The result runs clockwise on screen. */
export function insetPolygon(p: readonly Pt[], r: number): Pt[] {
  const cw = area(p) < 0 ? [...p].reverse() : [...p];
  if (!r) return cw;
  return cw.map((b, i): Pt => {
    const a = vertex(cw, i - 1);
    const c = vertex(cw, i + 1);
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
    // inward normals of the edge before and the edge after
    const n1: Pt = [-(b[1] - a[1]) / l1, (b[0] - a[0]) / l1];
    const n2: Pt = [-(c[1] - b[1]) / l2, (c[0] - b[0]) / l2];
    const k = r / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [+(b[0] + (n1[0] + n2[0]) * k).toFixed(6), +(b[1] + (n1[1] + n2[1]) * k).toFixed(6)];
  });
}

/**
 * The same outline as `count` points: every vertex stays, the extra points are shared between
 * the edges by length. The list starts at the point furthest up and to the left of the centre,
 * so two resampled shapes blend without twisting. `count` is at least the number of vertices.
 */
export function resamplePolygon(p: readonly Pt[], count: number): Pt[] {
  const lengths = p.map((a, i) => {
    const b = vertex(p, i + 1);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  });
  const total = lengths.reduce((sum, l) => sum + l, 0) || 1;
  const extra = Math.max(0, count - p.length);
  const add = lengths.map((l) => Math.floor((extra * l) / total));
  // largest remainder: the points left over go to the edges that were rounded down the most
  const left = extra - add.reduce((sum, v) => sum + v, 0);
  const byRemainder = lengths
    .map((l, i) => ({ i, rem: (extra * l) / total - (add[i] ?? 0) }))
    .sort((a, b) => b.rem - a.rem);
  for (const { i } of byRemainder.slice(0, left)) add[i] = (add[i] ?? 0) + 1;

  const out: Pt[] = [];
  p.forEach((a, i) => {
    const b = vertex(p, i + 1);
    const more = add[i] ?? 0;
    out.push(a);
    for (let k = 1; k <= more; k++) {
      const t = k / (more + 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  });

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of out) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let first = 0;
  let most = -Infinity;
  out.forEach(([x, y], i) => {
    const dx = x - cx;
    const dy = y - cy;
    const v = (-dx - dy) / (Math.hypot(dx, dy) || 1);
    if (v > most) {
      most = v;
      first = i;
    }
  });
  return [...out.slice(first), ...out.slice(0, first)];
}

/* ---------- the forms, on the mark's own grid (centred on (30, 30)) ---------- */

const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
const MAP = [rect(6, 6, 22, 22), rect(32, 6, 22, 22), rect(6, 32, 22, 22), rect(32, 32, 22, 22)];
const GLOBE = [
  sectorPolygon(28, 28, 0, 24, 180, 270),
  sectorPolygon(32, 28, 0, 24, 270, 360),
  sectorPolygon(28, 32, 0, 24, 90, 180),
  sectorPolygon(32, 32, 0, 24, 0, 90),
];
const DATES = [
  rect(2, 25.5, 9, 9),
  rect(16, 25.5, 9, 9),
  rect(30, 25.5, 9, 9),
  rect(43, 22.5, 15, 15),
];
/** A cube of edge 17, top vertex at (30, 18), and a plate lifted 11 above its top face: top, right, left, plate. */
function cube(): Pt[][] {
  const e = 17,
    cx = 30,
    y = 18,
    dx = e * Math.cos(Math.PI / 6),
    dy = e / 2;
  const top: Pt[] = [
    [cx, y],
    [cx + dx, y + dy],
    [cx, y + 2 * dy],
    [cx - dx, y + dy],
  ];
  return [
    top,
    [
      [cx, y + 2 * dy],
      [cx + dx, y + dy],
      [cx + dx, y + dy + e],
      [cx, y + 2 * dy + e],
    ],
    [
      [cx - dx, y + dy],
      [cx, y + 2 * dy],
      [cx, y + 2 * dy + e],
      [cx - dx, y + dy + e],
    ],
    top.map(([px, py]): Pt => [px, py - 11]),
  ];
}

const FULL: readonly number[] = [1, 1, 1, 1];
const NONE: readonly number[] = [0, 0, 0, 0];

function pose(
  label: string,
  polys: readonly (readonly Pt[])[],
  {
    rot = 0,
    halo = 0,
    opacity = FULL,
    extraInset = NONE,
  }: {
    rot?: number;
    halo?: number;
    opacity?: readonly number[];
    extraInset?: readonly number[];
  } = {},
): Pose {
  return {
    label,
    rot,
    halo,
    opacity,
    pts: polys.map((p, i) =>
      resamplePolygon(insetPolygon(p, QUARTER.corner + (extraInset[i] ?? 0)), POINTS),
    ),
  };
}

let rest: Pose | undefined;
const restPose = (): Pose => (rest ??= pose('Quarter', quarterPolygons()));

function build(name: MotionName): Motion {
  const mark = restPose();
  switch (name) {
    case 'stepOut':
      return {
        name,
        poses: [pose('Ring', ringPolygons()), mark],
        rest: mark,
        lead: 260,
        move: 600,
        stagger: 40,
        hold: 0,
        back: false,
        loops: false,
        fromFirst: true,
      };
    case 'sequence':
      return {
        name,
        poses: [
          pose('Map', MAP),
          // the three faces stand a little apart; the plate keeps its full size
          pose('Model', cube(), {
            halo: 2.2,
            opacity: [1, 0.5, 0.75, 1],
            extraInset: [0.9, 0.9, 0.9, 0],
          }),
          pose('Dates', DATES),
          pose('Globe', GLOBE),
          mark,
        ],
        rest: mark,
        lead: 0,
        move: 520,
        stagger: 55,
        hold: 360,
        back: false,
        loops: false,
        fromFirst: false,
      };
    case 'turns':
      return {
        name,
        poses: [90, 180, 270, 360].map((rot) => ({ ...mark, rot, label: `${String(rot)}°` })),
        rest: mark,
        lead: 0,
        move: 520,
        stagger: 45,
        hold: 200,
        back: true,
        loops: true,
        fromFirst: false,
      };
  }
}

const motions = new Map<MotionName, Motion>();

/** The named motion, built once. */
export function getMotion(name: MotionName): Motion {
  let m = motions.get(name);
  if (!m) {
    m = build(name);
    motions.set(name, m);
  }
  return m;
}

/** Milliseconds of one pass (one loop of a looping motion, its last hold included). */
export function motionLength(m: Motion): number {
  const span = m.move + 3 * m.stagger;
  const n = m.poses.length;
  if (m.fromFirst) return m.lead + (n - 1) * span + (n - 2) * m.hold;
  if (m.loops) return n * (span + m.hold);
  return n * span + (n - 1) * m.hold;
}

const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Overshoots a little past 1, then settles on it. */
const backOut = (t: number) => 1 + 2.1 * Math.pow(t - 1, 3) + 1.1 * Math.pow(t - 1, 2);
const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Path data of a piece `e` of the way from `a` to `b` (`e` may pass 1 on an overshoot). */
function outline(a: readonly Pt[], b: readonly Pt[], e: number): string {
  let d = '';
  for (let j = 0; j < b.length; j++) {
    const q = b[j] ?? ORIGIN;
    const p = a[j] ?? q;
    // exactly on a pose at both ends, so a finished motion equals the rest frame to the letter
    const x = e === 1 ? q[0] : p[0] + (q[0] - p[0]) * e;
    const y = e === 1 ? q[1] : p[1] + (q[1] - p[1]) * e;
    d += `${j ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return `${d}Z`;
}

/**
 * The four pieces `ms` into a motion. `pose` is the index of the pose being approached or held.
 * A looping motion wraps round and is never done; any other holds its last pose from
 * `motionLength` on.
 */
export function frameAt(
  m: Motion,
  ms: number,
): { pieces: PieceFrame[]; pose: number; done: boolean } {
  const length = motionLength(m);
  const span = m.move + 3 * m.stagger;
  const segment = span + m.hold;
  const last = m.poses.length - 1;
  let t = ms > 0 ? ms : 0;
  if (m.loops) t = Number.isFinite(t) && length > 0 ? t % length : 0;
  else t = Math.min(t, length);
  const index = (elapsed: number, max: number) =>
    Math.min(Math.max(0, max), segment > 0 ? Math.floor(elapsed / segment) : max);

  let from: Pose;
  let to: Pose;
  let approached: number;
  let local: number;
  if (m.fromFirst) {
    const first = m.poses[0] ?? m.rest;
    if (t < m.lead) {
      from = to = first;
      approached = 0;
      local = 0;
    } else {
      const k = index(t - m.lead, last - 1);
      approached = Math.min(k + 1, Math.max(0, last));
      from = m.poses[k] ?? first;
      to = m.poses[approached] ?? first;
      local = t - m.lead - k * segment;
    }
  } else {
    approached = index(t, last);
    from = approached ? (m.poses[approached - 1] ?? m.rest) : m.rest;
    to = m.poses[approached] ?? m.rest;
    local = t - approached * segment;
  }

  const back = m.back || (!m.loops && approached === last);
  const pieces: PieceFrame[] = [];
  for (let i = 0; i < PIECES; i++) {
    const p = m.move > 0 ? clamp((local - i * m.stagger) / m.move) : 1;
    const e = back ? backOut(p) : inOut(p);
    const k = clamp(e);
    const o0 = from.opacity[i] ?? 1;
    const o1 = to.opacity[i] ?? 1;
    pieces.push({
      d: outline(from.pts[i] ?? [], to.pts[i] ?? [], e),
      opacity: o0 + (o1 - o0) * k,
      rot: from.rot + (to.rot - from.rot) * e,
      halo: from.halo + (to.halo - from.halo) * k,
    });
  }
  return { pieces, pose: approached, done: !m.loops && ms >= length };
}

/** The still mark: what every motion comes to rest on. */
export function restFrame(): PieceFrame[] {
  return restPose().pts.map((pts) => ({ d: outline(pts, pts, 1), opacity: 1, rot: 0, halo: 0 }));
}
