import type { FrameRef, Layer, LensModel, Quat, Vec3 } from '@aio/schema';
import { clockForVideoTime } from './clock';
import type { Flight } from './flight';
import { imageToRay, rayToImage } from './lens';
import { orientCamera, quatConj, quatRotate } from './orientation';
import { interpolatePose } from './pose';

/**
 * Same view on the other date (M8 C4, FUS-4 and FUS-12): for a video frame or a photo of one
 * survey date, the frame or photo of another date whose camera saw the same place the same way.
 *
 * The cost of a candidate combines the camera distance, the angle between the view directions and
 * the overlap of the two footprints on the ground plane, all from the calibrated poses (flight log
 * plus the clip's `positionOffsetM` and `orientation`, data-conventions section 3). Videos are
 * searched coarse to fine: every `coarseStepS` along each clip of the other date, then frame by
 * frame around the best few. Pure geometry: nothing here loads a file.
 */

type VideoLayer = Extract<Layer, { kind: 'video' }>;
type PhotoLayer = Extract<Layer, { kind: 'photos' }>;

/** A calibrated camera: where it was, which way it looked, its lens. */
export interface ViewPose {
  pos: Vec3;
  q: Quat;
  lens: LensModel;
}

/** Where to look for the other view: a photo set, or a clip with its flight log. */
export type ViewSource =
  { kind: 'photos'; layer: PhotoLayer } | { kind: 'video'; layer: VideoLayer; flight: Flight };

export interface PairOptions {
  /** Largest camera distance, metres (default 25). */
  maxPoseM?: number;
  /** Largest angle between the view directions, degrees (default 30). */
  maxAngleDeg?: number;
  /** Smallest footprint overlap (intersection over union, 0 to 1; default 0.1). */
  minOverlap?: number;
  /** Height of the ground plane in the local frame (default 0, the project origin). */
  groundY?: number;
  /** Coarse search step along a clip, seconds (default 0.5). */
  coarseStepS?: number;
  /** Frame rate the fine search snaps to (default 30). */
  fps?: number;
}

export interface ViewMatch {
  /** The frame (`t`, video seconds) or photo of the other date. */
  ref: FrameRef;
  pose: ViewPose;
  distanceM: number;
  angleDeg: number;
  /** Footprint overlap, 0 to 1. */
  overlap: number;
  /** Lower is better. */
  cost: number;
}

/** The lens the inspection kit assumes for a photo that has none (70 degrees). */
export const DEFAULT_PHOTO_LENS: LensModel = { model: 'pinhole', hfovDeg: 70, aspect: 1.5 };

const DEFAULTS = {
  maxPoseM: 25,
  maxAngleDeg: 30,
  minOverlap: 0.1,
  groundY: 0,
  coarseStepS: 0.5,
  fps: 30,
} satisfies Required<PairOptions>;

const R2D = 180 / Math.PI;

/** The camera's view direction (its local -Z) in the local frame. */
export function viewDirection(q: Quat): Vec3 {
  return quatRotate(q, [0, 0, -1]);
}

function angleDeg(a: Vec3, b: Vec3): number {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const n = Math.hypot(...a) * Math.hypot(...b) || 1;
  return Math.acos(Math.min(1, Math.max(-1, d / n))) * R2D;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/* ------------------------------------------------------------------ poses of clips and photos */

/** Flight log time (ms since the log's start) of video second `v` of a clip. */
export function flightTimeMs(layer: VideoLayer, flight: Flight, v: number): number {
  const clock = clockForVideoTime(
    { startUtcMs: layer.flight.startUtcMs, offsetMs: layer.offsetMs, durationS: NaN },
    v,
  );
  return clock - flight.startUtcMs;
}

/** Video second of flight log time `tMs`. */
export function videoTimeS(layer: VideoLayer, flight: Flight, tMs: number): number {
  return (tMs + flight.startUtcMs - layer.flight.startUtcMs - layer.offsetMs) / 1000;
}

/** The calibrated camera of video second `v`: the logged pose, offset and turned by the clip's bias. */
export function calibratedVideoPose(layer: VideoLayer, flight: Flight, v: number): ViewPose {
  const s = interpolatePose(flight.samples, flightTimeMs(layer, flight, v));
  const o = layer.positionOffsetM;
  return {
    pos: o ? [s.pos[0] + o[0], s.pos[1] + o[1], s.pos[2] + o[2]] : s.pos,
    q: orientCamera(s.q, layer.orientation),
    lens: layer.lens,
  };
}

/** A photo's camera, or null when the photo has no position or orientation. */
export function photoPose(item: PhotoLayer['items'][number]): ViewPose | null {
  if (!item.pos || !item.q) return null;
  return { pos: item.pos, q: item.q, lens: item.lens ?? DEFAULT_PHOTO_LENS };
}

/* ------------------------------------------------------------------ ground footprints */

type P2 = [number, number];

/** Image border points (normalised) the footprint is cast from. */
const BORDER: P2[] = (() => {
  const s = [0, 0.25, 0.5, 0.75];
  return [
    ...s.map((x): P2 => [x, 0]),
    ...s.map((y): P2 => [1, y]),
    ...s.map((x): P2 => [1 - x, 1]),
    ...s.map((y): P2 => [0, 1 - y]),
  ];
})();

/** Each vertex with the next one, closing the ring. */
function edges(poly: readonly P2[]): [P2, P2][] {
  return poly.map((p, i): [P2, P2] => [p, poly[(i + 1) % poly.length] ?? p]);
}

const cross = (o: P2, a: P2, b: P2) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Half of Andrew's monotone chain: drop points that do not turn left. */
function chain(pts: readonly P2[]): P2[] {
  const out: P2[] = [];
  for (const p of pts) {
    for (;;) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      if (!a || !b || cross(a, b, p) > 0) break;
      out.pop();
    }
    out.push(p);
  }
  return out.slice(0, -1);
}

/** Convex hull, counter-clockwise. */
function hull(points: readonly P2[]): P2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  return [...chain(pts), ...chain([...pts].reverse())];
}

function area(poly: readonly P2[]): number {
  let s = 0;
  for (const [a, b] of edges(poly)) s += a[0] * b[1] - b[0] * a[1];
  return Math.abs(s) / 2;
}

/** Clip a convex polygon by another (Sutherland-Hodgman; both counter-clockwise). */
function clip(subject: readonly P2[], by: readonly P2[]): P2[] {
  let out: P2[] = [...subject];
  for (const [a, b] of edges(by)) {
    if (out.length === 0) break;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const inside = (p: P2) => ex * (p[1] - a[1]) - ey * (p[0] - a[0]) >= 0;
    const cut = (p: P2, q: P2): P2 => {
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const den = dx * ey - dy * ex;
      const t = den === 0 ? 0 : ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
      return [p[0] + t * dx, p[1] + t * dy];
    };
    const input = out;
    out = [];
    for (const [p, q] of edges(input)) {
      if (inside(q)) {
        if (!inside(p)) out.push(cut(p, q));
        out.push(q);
      } else if (inside(p)) out.push(cut(p, q));
    }
  }
  return out;
}

/**
 * What the camera sees of the ground plane `y = groundY`, as a convex polygon of `[x, z]`. Rays
 * that miss the ground (above the horizon) or reach it beyond `maxRangeM` stop at that range.
 * Null when the camera is below the ground or sees none of it.
 */
export function groundFootprint(pose: ViewPose, groundY = 0, maxRangeM = 300): P2[] | null {
  const h = pose.pos[1] - groundY;
  if (!(h > 0)) return null;
  const pts: P2[] = [];
  let hits = 0;
  for (const [x, y] of BORDER) {
    const d = quatRotate(pose.q, imageToRay(pose.lens, x, y));
    const horiz = Math.hypot(d[0], d[2]);
    let t = d[1] < -1e-9 ? h / -d[1] : Infinity;
    if (t * horiz > maxRangeM) t = horiz > 1e-9 ? maxRangeM / horiz : Infinity;
    else hits++;
    if (!Number.isFinite(t)) continue;
    pts.push([pose.pos[0] + d[0] * t, pose.pos[2] + d[2] * t]);
  }
  if (hits === 0 || pts.length < 3) return null;
  const poly = hull(pts);
  return area(poly) > 1e-9 ? poly : null;
}

/** Intersection over union of the two cameras' ground footprints (0 when either sees no ground). */
export function footprintOverlap(a: ViewPose, b: ViewPose, groundY = 0): number {
  const fa = groundFootprint(a, groundY);
  const fb = groundFootprint(b, groundY);
  return fa && fb ? polygonIoU(fa, fb) : 0;
}

function polygonIoU(fa: readonly P2[], fb: readonly P2[]): number {
  const inter = area(clip(fa, fb));
  const union = area(fa) + area(fb) - inter;
  return union > 0 ? Math.min(1, inter / union) : 0;
}

/* ------------------------------------------------------------------ matching */

interface Scored {
  ref: FrameRef;
  pose: ViewPose;
  distanceM: number;
  angleDeg: number;
}

/** Cheap part of the cost (distance and angle), Infinity beyond the limits. */
function quick(target: ViewPose, dir: Vec3, pose: ViewPose, o: Required<PairOptions>) {
  const d = dist(target.pos, pose.pos);
  if (d > o.maxPoseM) return null;
  const a = angleDeg(dir, viewDirection(pose.q));
  if (a > o.maxAngleDeg) return null;
  return { distanceM: d, angleDeg: a, partial: d / o.maxPoseM + a / o.maxAngleDeg };
}

function finish(s: Scored, targetFp: P2[] | null, o: Required<PairOptions>): ViewMatch | null {
  const fp = groundFootprint(s.pose, o.groundY);
  const overlap = targetFp && fp ? polygonIoU(targetFp, fp) : 0;
  if (overlap < o.minOverlap || (o.minOverlap > 0 && overlap === 0)) return null;
  return {
    ...s,
    overlap,
    cost:
      s.distanceM / o.maxPoseM + s.angleDeg / o.maxAngleDeg + Math.max(0, POOR_OVERLAP - overlap),
  };
}

/**
 * Footprint overlap below this adds to the cost; above it the cameras see the same ground and the
 * pose decides, so the closest camera wins (overlap alone would favour a higher camera's wider view).
 */
const POOR_OVERLAP = 0.5;

const better = (a: ViewMatch | null, b: ViewMatch | null) =>
  !a ? b : !b ? a : b.cost < a.cost ? b : a;

function searchPhotos(
  target: ViewPose,
  dir: Vec3,
  fp: P2[] | null,
  layer: PhotoLayer,
  o: Required<PairOptions>,
): ViewMatch | null {
  let best: ViewMatch | null = null;
  for (const item of layer.items) {
    const pose = photoPose(item);
    if (!pose) continue;
    const q = quick(target, dir, pose, o);
    if (!q) continue;
    best = better(best, finish({ ref: { layer: layer.id, photo: item.id }, pose, ...q }, fp, o));
  }
  return best;
}

function searchVideo(
  target: ViewPose,
  dir: Vec3,
  fp: P2[] | null,
  layer: VideoLayer,
  flight: Flight,
  o: Required<PairOptions>,
): ViewMatch | null {
  const first = flight.samples[0];
  const last = flight.samples.at(-1);
  if (!first || !last) return null;
  const v0 = Math.max(0, videoTimeS(layer, flight, first.t));
  const v1 = videoTimeS(layer, flight, last.t);
  if (!(v1 >= v0)) return null;
  const at = (v: number): Scored | null => {
    const pose = calibratedVideoPose(layer, flight, v);
    const q = quick(target, dir, pose, o);
    return q ? { ref: { layer: layer.id, t: v }, pose, ...q } : null;
  };
  // coarse: the few best seconds by distance and angle
  const coarse: { v: number; partial: number }[] = [];
  const step = o.coarseStepS;
  for (let v = v0; v <= v1 + 1e-9; v += step) {
    const pose = calibratedVideoPose(layer, flight, v);
    const q = quick(target, dir, pose, o);
    if (q) coarse.push({ v, partial: q.partial });
  }
  coarse.sort((a, b) => a.partial - b.partial);
  // fine: frame by frame around each, keeping the best whole cost
  const frame = 1 / o.fps;
  let best: ViewMatch | null = null;
  const seen = new Set<number>();
  for (const c of coarse.slice(0, 4)) {
    const lo = Math.max(v0, c.v - step);
    const hi = Math.min(v1, c.v + step);
    for (let k = Math.ceil(lo / frame - 1e-9); k * frame <= hi + 1e-9; k++) {
      if (seen.has(k)) continue;
      seen.add(k);
      const s = at(k * frame);
      if (s) best = better(best, finish(s, fp, o));
    }
  }
  if (best?.ref.t !== undefined) best.ref = { layer: layer.id, t: roundTime(best.ref.t) };
  return best;
}

/** Video seconds rounded to the microsecond, so frame times print and compare cleanly. */
const roundTime = (v: number) => Math.round(v * 1e6) / 1e6 + 0;

/** The best view of `sources` for the camera `target`, or null when none is close enough. */
export function matchView(
  target: ViewPose,
  sources: readonly ViewSource[],
  options: PairOptions = {},
): ViewMatch | null {
  const o = { ...DEFAULTS, ...options };
  const dir = viewDirection(target.q);
  const fp = groundFootprint(target, o.groundY);
  let best: ViewMatch | null = null;
  for (const s of sources) {
    const m =
      s.kind === 'photos'
        ? searchPhotos(target, dir, fp, s.layer, o)
        : searchVideo(target, dir, fp, s.layer, s.flight, o);
    best = better(best, m);
  }
  return best;
}

/**
 * A matcher for scrubbing: the same pose is answered from a cache, and the clip or photo set of
 * the last answer is preferred unless another is clearly better (10% lower cost), so the other
 * date does not jump between parallel strips.
 */
export function createViewFollower(
  sources: readonly ViewSource[],
  options: PairOptions = {},
): (target: ViewPose) => ViewMatch | null {
  let lastKey = '';
  let lastMatch: ViewMatch | null = null;
  return (target) => {
    const key = `${target.pos.join(',')}|${target.q.join(',')}`;
    if (key === lastKey) return lastMatch;
    const weighed = (m: ViewMatch) => m.cost * (m.ref.layer === lastMatch?.ref.layer ? 0.9 : 1);
    let best: ViewMatch | null = null;
    for (const s of sources) {
      const m = matchView(target, [s], options);
      if (m && (!best || weighed(m) < weighed(best))) best = m;
    }
    lastKey = key;
    lastMatch = best;
    return best;
  };
}

/* ------------------------------------------------------------------ pairs of two dates */

/** Photo and video layers of one date: an explicit `capture` first, else the date index. */
export function viewSources(
  layers: readonly Layer[],
  capture: string,
  captureOf: Readonly<Record<string, string>>,
  flights: ReadonlyMap<string, Flight>,
): ViewSource[] {
  const out: ViewSource[] = [];
  for (const l of layers) {
    const c = (l as { capture?: string }).capture ?? captureOf[l.id];
    if (c !== capture) continue;
    if (l.kind === 'photos') out.push({ kind: 'photos', layer: l });
    else if (l.kind === 'video') {
      const flight = flights.get(l.id);
      if (flight) out.push({ kind: 'video', layer: l, flight });
    }
  }
  return out;
}

export interface FramePair {
  a: FrameRef;
  b: FrameRef;
  poseM: number;
  angleDeg: number;
  overlap: number;
  cost: number;
}

export interface PairsContext {
  layers: readonly Layer[];
  /** Capture of each dated layer (`CaptureIndex.of`). */
  captureOf: Readonly<Record<string, string>>;
  /** Parsed flight logs by video layer id (clips without one are skipped). */
  flights: ReadonlyMap<string, Flight>;
}

export interface PairsOptions extends PairOptions {
  /** Photos of both dates only (detection matching): no video frames. */
  photosOnly?: boolean;
  /** Also pair video frames of date A, one every this many seconds (default: photos only). */
  videoStepS?: number;
}

/**
 * Each photo of `captureA` (and, with `videoStepS`, a frame of each of its clips every so many
 * seconds) with its best view of `captureB`. Views with no counterpart close enough are left out.
 */
export function pairsFor(
  captureA: string,
  captureB: string,
  ctx: PairsContext,
  options: PairsOptions = {},
): FramePair[] {
  const keep = (s: ViewSource) => !options.photosOnly || s.kind === 'photos';
  const a = viewSources(ctx.layers, captureA, ctx.captureOf, ctx.flights).filter(keep);
  const b = viewSources(ctx.layers, captureB, ctx.captureOf, ctx.flights).filter(keep);
  const out: FramePair[] = [];
  const add = (ref: FrameRef, pose: ViewPose) => {
    const m = matchView(pose, b, options);
    if (m)
      out.push({
        a: ref,
        b: m.ref,
        poseM: m.distanceM,
        angleDeg: m.angleDeg,
        overlap: m.overlap,
        cost: m.cost,
      });
  };
  for (const s of a) {
    if (s.kind === 'photos') {
      for (const item of s.layer.items) {
        const pose = photoPose(item);
        if (pose) add({ layer: s.layer.id, photo: item.id }, pose);
      }
    } else if ((options.videoStepS ?? 0) > 0) {
      const step = options.videoStepS ?? 1;
      const first = s.flight.samples[0];
      const last = s.flight.samples.at(-1);
      if (!first || !last) continue;
      const v0 = Math.max(0, videoTimeS(s.layer, s.flight, first.t));
      const v1 = videoTimeS(s.layer, s.flight, last.t);
      for (let k = Math.ceil(v0 / step - 1e-9); k * step <= v1 + 1e-9; k++) {
        const v = roundTime(k * step);
        add({ layer: s.layer.id, t: v }, calibratedVideoPose(s.layer, s.flight, v));
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ warping by the ground plane */

/** A 3 x 3 homography, row major, acting on normalised image points `[x, y, 1]`. */
export type Homography = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export function applyHomography(H: Homography, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f, g, h, i] = H;
  const w = g * x + h * y + i;
  return [(a * x + b * y + c) / w, (d * x + e * y + f) / w];
}

/** Solve the 8 x 8 system `A x = b` by Gaussian elimination with pivoting; null when singular. */
function solve8(A: Float64Array, b: Float64Array): Float64Array | null {
  const n = 8;
  const at = (r: number, c: number) => A[r * n + c] ?? 0;
  const swap = (r1: number, r2: number) => {
    for (let c = 0; c < n; c++) {
      const t = at(r1, c);
      A[r1 * n + c] = at(r2, c);
      A[r2 * n + c] = t;
    }
    const t = b[r1] ?? 0;
    b[r1] = b[r2] ?? 0;
    b[r2] = t;
  };
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(at(r, c)) > Math.abs(at(p, c))) p = r;
    if (Math.abs(at(p, c)) < 1e-12) return null;
    if (p !== c) swap(p, c);
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = at(r, c) / at(c, c);
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] = at(r, k) - f * at(c, k);
      b[r] = (b[r] ?? 0) - f * (b[c] ?? 0);
    }
  }
  return b.map((v, i) => v / at(i, i));
}

/** Least-squares homography (h22 = 1) from point pairs; null with fewer than four. */
export function fitHomography(src: readonly P2[], dst: readonly P2[]): Homography | null {
  if (src.length < 4 || src.length !== dst.length) return null;
  const AtA = new Float64Array(64);
  const Atb = new Float64Array(8);
  const addRow = (row: readonly number[], rhs: number) => {
    row.forEach((ri, i) => {
      Atb[i] = (Atb[i] ?? 0) + ri * rhs;
      row.forEach((rj, j) => {
        AtA[i * 8 + j] = (AtA[i * 8 + j] ?? 0) + ri * rj;
      });
    });
  };
  src.forEach(([x, y], i) => {
    const [u, v] = dst[i] ?? [0, 0];
    addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  });
  const h = solve8(AtA, Atb);
  if (!h) return null;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, k = 0] = h;
  return [a, b, c, d, e, f, g, k, 1];
}

/**
 * The homography that carries image points of camera `from` to camera `to` through the ground
 * plane `y = groundY`, in normalised image coordinates. Fitted on a grid of ground points both
 * cameras see, so it also serves fisheye lenses near the centre. Null when they share too little.
 */
export function groundHomography(from: ViewPose, to: ViewPose, groundY = 0): Homography | null {
  const src: P2[] = [];
  const dst: P2[] = [];
  const inv = quatConj(to.q);
  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 6; j++) {
      const x = 0.1 + (0.8 * i) / 6;
      const y = 0.1 + (0.8 * j) / 6;
      const d = quatRotate(from.q, imageToRay(from.lens, x, y));
      if (!(d[1] < -1e-9)) continue;
      const t = (from.pos[1] - groundY) / -d[1];
      if (!(t > 0)) continue;
      const g: Vec3 = [from.pos[0] + d[0] * t, groundY, from.pos[2] + d[2] * t];
      const c = quatRotate(inv, [g[0] - to.pos[0], g[1] - to.pos[1], g[2] - to.pos[2]]);
      const p = rayToImage(to.lens, c);
      if (!p || p[0] < -0.5 || p[0] > 1.5 || p[1] < -0.5 || p[1] > 1.5) continue;
      src.push([x, y]);
      dst.push(p);
    }
  }
  return src.length >= 8 ? fitHomography(src, dst) : null;
}

/**
 * A CSS `matrix3d` that draws an element of `width` x `height` pixels (transform origin at its top
 * left corner) through the homography `H` of normalised coordinates.
 */
export function homographyCss(H: Homography, width: number, height: number): string {
  // pixel homography S H S^-1 with S = diag(width, height, 1)
  const w = width;
  const h = height;
  const [a, b, c, d, e, f, g, k, i] = H;
  const p = [a, (b * w) / h, c * w, (d * h) / w, e, f * h, g / w, k / h, i] as const;
  const m = [p[0], p[3], 0, p[6], p[1], p[4], 0, p[7], 0, 0, 1, 0, p[2], p[5], 0, p[8]];
  return `matrix3d(${m.map((v) => String(Number(v.toPrecision(12)))).join(',')})`;
}

/** "2.1 m, 4 degrees apart" parts for the score text: metres to 0.1, degrees whole. */
export function matchScore(m: Pick<ViewMatch, 'distanceM' | 'angleDeg'>): {
  metres: string;
  degrees: string;
} {
  return { metres: m.distanceM.toFixed(1), degrees: String(Math.round(m.angleDeg)) };
}
