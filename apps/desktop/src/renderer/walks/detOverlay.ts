/**
 * Detections on a walk frame, drawn over the 360 view. Pure: a box in equirect pixels of the
 * walk's playback copy (x1 > width wraps across the seam) becomes screen polylines for the view's
 * look. Conventions follow `panoMath.ts` and `@aio/video` `createPanoVideoView`: the picture centre
 * is yaw 0, east to its right, yaw clockwise, pitch up; the camera looks along the look with Y up
 * and its fov is vertical (three.js), the horizontal one following from the view's aspect.
 */
import type { Detection } from '@aio/annotate/detections';
import { azElToDir, type PanoLook } from '@aio/engine';

type Vec3 = readonly [number, number, number];
export type ScreenPoint = [number, number];
export interface Size {
  width: number;
  height: number;
}

const RAD = Math.PI / 180;
/** Points nearer the camera plane than this (unit sphere) are cut: they project too far out. */
const NEAR = 0.02;
/** Samples per edge at least; long edges get one every few degrees. */
const PER_EDGE = 8;
const MAX_STEP_DEG = 4;
/** A sampled frame's detections show at most this far from it (with less, half the interval). */
export const NEAR_FRAME_S = 1;

/** Yaw and pitch (degrees) of a pixel of a `w` x `h` equirectangular frame. */
export function pixelToLook(x: number, y: number, w: number, h: number): [number, number] {
  return [(x / w - 0.5) * 360, (0.5 - y / h) * 180];
}

/** The camera frame of a look: forward, right and up unit vectors. */
function basis(look: PanoLook): { f: Vec3; r: Vec3; u: Vec3 } {
  const az = look.yawDeg * RAD;
  const f = azElToDir(look.yawDeg, look.pitchDeg);
  // right = forward x Y (level), up = right x forward
  const r: Vec3 = [Math.cos(az), 0, Math.sin(az)];
  const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { f, r, u };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Cam {
  /** Right, up and depth (along the look) of a direction in the camera frame. */
  cam: (d: Vec3) => Vec3;
  screen: (c: Vec3) => ScreenPoint;
}

function camera(look: PanoLook, view: Size): Cam {
  const { f, r, u } = basis(look);
  const tv = Math.tan((look.fovDeg * RAD) / 2);
  const th = tv * (view.height > 0 ? view.width / view.height : 1);
  return {
    cam: (d) => [dot(d, r), dot(d, u), dot(d, f)],
    screen: ([cx, cy, cz]) => [
      (view.width / 2) * (1 + cx / (cz * th)),
      (view.height / 2) * (1 - cy / (cz * tv)),
    ],
  };
}

/** Screen pixels of a direction in a `view` looking along `look`; null behind the camera. */
export function projectDir(d: Vec3, look: PanoLook, view: Size): ScreenPoint | null {
  const c = camera(look, view);
  const p = c.cam(d);
  return p[2] > NEAR ? c.screen(p) : null;
}

/** The closed ring of directions around a box's edges, each edge sampled along the frame. */
function boxRing(box: readonly [number, number, number, number], frame: Size): Vec3[] {
  const [x0, y0, x1, y1] = box;
  const [yaw0, pitch0] = pixelToLook(x0, y0, frame.width, frame.height);
  const [yaw1, pitch1] = pixelToLook(x1, y1, frame.width, frame.height);
  const nx = Math.max(PER_EDGE, Math.ceil(Math.abs(yaw1 - yaw0) / MAX_STEP_DEG));
  const ny = Math.max(PER_EDGE, Math.ceil(Math.abs(pitch1 - pitch0) / MAX_STEP_DEG));
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
  const out: Vec3[] = [];
  // top left to right, right side down, bottom right to left, left side up
  for (let i = 0; i < nx; i++) out.push(azElToDir(lerp(yaw0, yaw1, i / nx), pitch0));
  for (let i = 0; i < ny; i++) out.push(azElToDir(yaw1, lerp(pitch0, pitch1, i / ny)));
  for (let i = 0; i < nx; i++) out.push(azElToDir(lerp(yaw1, yaw0, i / nx), pitch1));
  for (let i = 0; i < ny; i++) out.push(azElToDir(yaw0, lerp(pitch1, pitch0, i / ny)));
  return out;
}

export interface BoxLines {
  /** Polylines in screen pixels; one closed ring when all of the box is in front. */
  lines: ScreenPoint[][];
  /** The topmost drawn point, for the label; null when nothing is drawn. */
  anchor: ScreenPoint | null;
}

/**
 * Screen polylines of a box `[x0, y0, x1, y1]` in pixels of a `frame` (x1 > width wraps across
 * the seam), seen in a `view` looking along `look`. The parts behind the camera are cut off, so a
 * box reaching behind it comes back as open pieces.
 */
export function boxScreenLines(
  box: readonly [number, number, number, number],
  frame: Size,
  look: PanoLook,
  view: Size,
): BoxLines {
  const c = camera(look, view);
  const ring = boxRing(box, frame).map(c.cam);
  const n = ring.length;
  const front = ring.map((p) => p[2] > NEAR);
  const at = (a: Vec3, b: Vec3): Vec3 => {
    const k = (NEAR - a[2]) / (b[2] - a[2]);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, NEAR];
  };
  let lines: ScreenPoint[][];
  if (front.every(Boolean)) {
    const pts = ring.map(c.screen);
    const first = pts[0];
    lines = first ? [[...pts, first]] : [];
  } else {
    // walk the ring from a point behind the camera, so no piece runs over its start
    const start = front.indexOf(false);
    lines = [];
    let cur: ScreenPoint[] = [];
    for (let i = 0; i < n; i++) {
      const ia = (start + i) % n;
      const ib = (start + i + 1) % n;
      const a = ring[ia];
      const b = ring[ib];
      if (!a || !b) continue;
      const fa = front[ia] === true;
      const fb = front[ib] === true;
      if (fa && fb) {
        if (cur.length === 0) cur.push(c.screen(a));
        cur.push(c.screen(b));
      } else if (!fa && fb) {
        cur = [c.screen(at(a, b)), c.screen(b)];
      } else if (fa && !fb) {
        if (cur.length === 0) cur.push(c.screen(a));
        cur.push(c.screen(at(a, b)));
        lines.push(cur);
        cur = [];
      }
    }
    if (cur.length > 1) lines.push(cur);
  }
  let anchor: ScreenPoint | null = null;
  for (const p of lines.flat()) if (!anchor || p[1] < anchor[1]) anchor = p;
  return { lines, anchor };
}

/**
 * The detections of walk layer `layer` to show at playback time `t`: those of the nearest sampled
 * frame (not rejected), none when that frame found nothing. The sampled frames are the pass's
 * `assessed` times (`samples`, seconds) plus the frames that hold detections, so without the
 * assessed times the detection frames stand in. The nearest frame counts while `t` is within half
 * the gap to its neighbour on `t`'s side (the other side at the ends), and at most a second.
 */
export function framesNear(
  list: readonly Detection[],
  layer: string,
  t: number,
  samples: readonly number[] = [],
): Detection[] {
  const ms = (x: number) => Math.round(x * 1000);
  const own = list.filter((d) => d.source.kind === 'frame' && d.source.layer === layer);
  const times = [
    ...new Set([
      ...samples.map(ms),
      ...own.map((d) => (d.source.kind === 'frame' ? ms(d.source.t) : 0)),
    ]),
  ].sort((a, b) => a - b);
  if (times.length === 0) return [];
  const at = ms(t);
  let i = 0;
  for (let k = 1; k < times.length; k++) {
    if (Math.abs((times[k] ?? 0) - at) < Math.abs((times[i] ?? 0) - at)) i = k;
  }
  const best = times[i] ?? 0;
  const prev = times[i - 1];
  const next = times[i + 1];
  const gap =
    at >= best
      ? next !== undefined
        ? next - best
        : prev !== undefined
          ? best - prev
          : null
      : prev !== undefined
        ? best - prev
        : next !== undefined
          ? next - best
          : null;
  const window = Math.min(NEAR_FRAME_S * 1000, gap === null ? Infinity : gap / 2);
  if (Math.abs(at - best) > window) return [];
  return own.filter(
    (d) => d.source.kind === 'frame' && d.status !== 'rejected' && ms(d.source.t) === best,
  );
}
