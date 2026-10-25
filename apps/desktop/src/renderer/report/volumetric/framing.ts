/**
 * The framing of the report's pictures (spec section 7): the top-down shots share one frame over
 * the piles' extent, `px = (e - e0) / mPerPx`, `py = (n1 - n) / mPerPx`, rendered through an
 * orthographic camera looking straight down (north up) so the frame is exact; the 3D shot looks
 * from the south-east at 35 degrees with the whole yard in view.
 */
import { projectToLocal } from '@aio/geo';
import type { Vec3 } from '@aio/schema';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';

/** [e0, n0, e1, n1] in the project CRS. */
export type Extent = readonly [number, number, number, number];

/** A site point on the ground, (E, N). */
export type SiteEN = readonly [number, number];

export interface Framing {
  /** The extent the pixels cover exactly. */
  extent: [number, number, number, number];
  widthPx: number;
  heightPx: number;
  mPerPx: number;
  /** (E, N) to a pixel (x, y) from the top left. */
  toPx(p: SiteEN): [number, number];
  /** A pixel back to (E, N). */
  toSite(px: readonly [number, number]): [number, number];
}

/** The frame of `extent` with its longest side `maxSide` pixels, grown to whole pixels. */
export function frameFor(extent: Extent, maxSide: number): Framing {
  const [a0, b0, a1, b1] = extent;
  const spanE = a1 - a0;
  const spanN = b1 - b0;
  const mPerPx = Math.max(spanE, spanN) / maxSide;
  const widthPx = Math.max(1, Math.ceil(spanE / mPerPx - 1e-9));
  const heightPx = Math.max(1, Math.ceil(spanN / mPerPx - 1e-9));
  const ce = (a0 + a1) / 2;
  const cn = (b0 + b1) / 2;
  const e0 = ce - (widthPx * mPerPx) / 2;
  const n0 = cn - (heightPx * mPerPx) / 2;
  const e1 = ce + (widthPx * mPerPx) / 2;
  const n1 = cn + (heightPx * mPerPx) / 2;
  return {
    extent: [e0, n0, e1, n1],
    widthPx,
    heightPx,
    mPerPx,
    toPx: ([e, n]) => [(e - e0) / mPerPx, (n1 - n) / mPerPx],
    toSite: ([x, y]) => [e0 + x * mPerPx, n1 - y * mPerPx],
  };
}

/**
 * The yard: the extent of the piles' outlines plus a margin of a tenth of its longer side, at
 * least `minMarginM` metres; null without a pile.
 */
export function yardExtent(
  rings: readonly (readonly (readonly number[])[])[],
  opts: { margin?: number; minMarginM?: number } = {},
): [number, number, number, number] | null {
  let e0 = Infinity;
  let n0 = Infinity;
  let e1 = -Infinity;
  let n1 = -Infinity;
  for (const ring of rings)
    for (const p of ring) {
      const e = p[0];
      const n = p[1];
      if (e === undefined || n === undefined) continue;
      e0 = Math.min(e0, e);
      n0 = Math.min(n0, n);
      e1 = Math.max(e1, e);
      n1 = Math.max(n1, n);
    }
  if (!Number.isFinite(e0) || !Number.isFinite(n0)) return null;
  const m = Math.max((opts.margin ?? 0.1) * Math.max(e1 - e0, n1 - n0), opts.minMarginM ?? 10);
  return [e0 - m, n0 - m, e1 + m, n1 + m];
}

const local = (p: Vec3, origin: Vec3) => new Vector3(...projectToLocal(p, origin));

/**
 * The orthographic camera of a top-down frame: straight down, north up, the extent exactly in
 * view for every height in `heights` ([lowest, highest] of the ground, metres in the CRS).
 */
export function topDownCamera(
  f: Pick<Framing, 'extent'>,
  origin: Vec3,
  heights: readonly [number, number],
): OrthographicCamera {
  const [e0, n0, e1, n1] = f.extent;
  const [lo, hi] = heights;
  const above = Math.max(100, (hi - lo) * 0.5);
  const centre = local([(e0 + e1) / 2, (n0 + n1) / 2, hi + above], origin);
  const halfW = (e1 - e0) / 2;
  const halfH = (n1 - n0) / 2;
  // far reaches well under the lowest toe: pits and the ground around the piles stay in
  const cam = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, hi - lo + above + 500);
  cam.position.copy(centre);
  // local -z is north: with it as the camera's up, north is up and east is right
  cam.up.set(0, 0, -1);
  cam.lookAt(centre.x, centre.y - 1, centre.z);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

/**
 * The 3D shot's camera: from `azimuthDeg` (compass, 135 the south-east) down at `elevationDeg`,
 * backed off until the whole yard (its corners at both heights) is in view.
 */
export function angledCamera(
  extent: Extent,
  origin: Vec3,
  heights: readonly [number, number],
  aspect: number,
  opts: { azimuthDeg?: number; elevationDeg?: number; fovDeg?: number } = {},
): PerspectiveCamera {
  const az = ((opts.azimuthDeg ?? 135) * Math.PI) / 180;
  const el = ((opts.elevationDeg ?? 35) * Math.PI) / 180;
  const fov = opts.fovDeg ?? 50;
  const [e0, n0, e1, n1] = extent;
  const [lo, hi] = heights;
  const target = local([(e0 + e1) / 2, (n0 + n1) / 2, (lo + hi) / 2], origin);
  // the direction from the target to the eye: east is +x, north is -z
  const toEye = new Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el),
  ).normalize();
  const corners: Vector3[] = [];
  for (const e of [e0, e1])
    for (const n of [n0, n1]) for (const h of [lo, hi]) corners.push(local([e, n, h], origin));
  const radius = Math.max(...corners.map((c) => c.distanceTo(target)), 1);
  const cam = new PerspectiveCamera(fov, aspect, radius / 100, radius * 20);
  const fits = (d: number) => {
    cam.position.copy(target).addScaledVector(toEye, d);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    return corners.every((c) => {
      const v = c.clone().project(cam);
      return v.z < 1 && Math.abs(v.x) <= 0.96 && Math.abs(v.y) <= 0.96;
    });
  };
  // the distance where the bounding sphere fits, then closer while the corners still do
  const vHalf = ((fov / 2) * Math.PI) / 180;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  let d = radius / Math.sin(Math.min(vHalf, hHalf));
  for (let i = 0; i < 40 && fits(d * 0.95); i++) d *= 0.95;
  fits(d);
  return cam;
}

/** Where a local point falls on a `w` x `h` picture taken through `camera`; null behind it. */
export function pixelOf(
  camera: PerspectiveCamera | OrthographicCamera,
  p: readonly [number, number, number],
  w: number,
  h: number,
): [number, number] | null {
  camera.updateMatrixWorld(true);
  const v = new Vector3(p[0], p[1], p[2]).applyMatrix4(camera.matrixWorldInverse);
  if (camera instanceof PerspectiveCamera && v.z >= 0) return null;
  v.applyMatrix4(camera.projectionMatrix);
  return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
}
