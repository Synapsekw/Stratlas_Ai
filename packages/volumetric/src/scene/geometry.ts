import { Plane, Vector3, type PerspectiveCamera } from 'three';
import type { BodyCells } from '../model/bodies';

export type ToLocal = (E: number, N: number, H: number) => [number, number, number];

/** Project CRS (easting, northing, height) to the local frame (x east, y up, z south). */
export function toLocalFn(origin: readonly [number, number, number]): ToLocal {
  return (E, N, H) => [E - origin[0], H - origin[2], origin[1] - N];
}

/** Material removed (cut) and placed (fill), linear RGB as in the kit. */
export const CUT_RGB = [0.86, 0.33, 0.16] as const;
export const FILL_RGB = [0.22, 0.52, 0.86] as const;

export interface BodyGeometry {
  /** Vertex positions of the top surface and of the base, one per cell (local frame). */
  top: Float32Array;
  bottom: Float32Array;
  index: Uint32Array;
  /** Change bodies: per-vertex colour by the sign of the change. */
  colors: Float32Array | null;
  /** Vertical hatch posts from base to top, segment pairs. */
  hatch: Float32Array;
  hatchColors: Float32Array | null;
  /** Height the body floats above the pile, m. */
  lift: number;
}

/** The kit viewer's `makeBody`: top and base surfaces of a body, lifted or in place. */
export function bodyGeometry(
  b: BodyCells,
  local: ToLocal,
  opts: { lifted: boolean; change: boolean },
): BodyGeometry {
  const n = b.nx * b.ny;
  const lift = opts.lifted ? b.tmax - b.bmin + 3 : 0;
  const top = new Float32Array(n * 3);
  const bottom = new Float32Array(n * 3);
  const colors = opts.change ? new Float32Array(n * 3) : null;
  const colourOf = (v: number) => ((b.d?.[v] ?? 0) < 0 ? CUT_RGB : FILL_RGB);
  for (let j = 0; j < b.ny; j++) {
    const N = b.n0 - j * b.cell;
    for (let i = 0; i < b.nx; i++) {
      const v = j * b.nx + i;
      if (!b.ins[v]) continue;
      const E = b.e0 + i * b.cell;
      const t = local(E, N, (b.top[v] ?? 0) + lift + (opts.lifted ? 0 : 0.2));
      const s = local(E, N, (b.bot[v] ?? 0) + lift);
      top.set(t, v * 3);
      bottom.set(s, v * 3);
      if (colors) colors.set(colourOf(v), v * 3);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < b.ny - 1; j++)
    for (let i = 0; i < b.nx - 1; i++) {
      const a = j * b.nx + i;
      const c = a + b.nx;
      if (b.ins[a] && b.ins[a + 1] && b.ins[c] && b.ins[c + 1])
        idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  const hp: number[] = [];
  const hc: number[] = [];
  if (opts.lifted) {
    const hs = Math.max(1, Math.round(1 / b.cell));
    for (let j = 0; j < b.ny; j += hs)
      for (let i = 0; i < b.nx; i += hs) {
        const v = j * b.nx + i;
        if (!b.ins[v] || (b.top[v] ?? 0) - (b.bot[v] ?? 0) < 0.08) continue;
        hp.push(bottom[v * 3] ?? 0, bottom[v * 3 + 1] ?? 0, bottom[v * 3 + 2] ?? 0);
        hp.push(top[v * 3] ?? 0, top[v * 3 + 1] ?? 0, top[v * 3 + 2] ?? 0);
        if (colors) hc.push(...colourOf(v), ...colourOf(v));
      }
  }
  return {
    top,
    bottom,
    index: Uint32Array.from(idx),
    colors,
    hatch: Float32Array.from(hp),
    hatchColors: colors ? Float32Array.from(hc) : null,
    lift,
  };
}

const UP = new Vector3();
const DIR = new Vector3();
const RIGHT = new Vector3();
const N = new Vector3();

/**
 * A world plane through the camera that projects to the vertical screen line at `x` (0 left,
 * 1 right); points right of the line are on its positive side.
 */
export function swipePlane(camera: PerspectiveCamera, x: number, out = new Plane()): Plane {
  camera.updateMatrixWorld();
  UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
  RIGHT.set(1, 0, 0).applyQuaternion(camera.quaternion);
  DIR.set(x * 2 - 1, 0, 0.5)
    .unproject(camera)
    .sub(camera.position)
    .normalize();
  N.crossVectors(DIR, UP).normalize();
  if (N.dot(RIGHT) < 0) N.negate();
  return out.setFromNormalAndCoplanarPoint(N, camera.position);
}
