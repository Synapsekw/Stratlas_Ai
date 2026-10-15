/**
 * 4 x 4 matrices (Float64, column-major, as three.js stores them) between the project CRS
 * (E, N, H) and the viewer's local frame (x east, y up, z south, from the project origin;
 * data-conventions section 1). Float64 throughout: UTM coordinates lose centimetres in float32.
 */
import type { ClipBox } from '@aio/schema';

type V3 = readonly [number, number, number];
export type M4 = Float64Array;

export function mul4(a: ArrayLike<number>, b: ArrayLike<number>): M4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = s;
    }
  return out;
}

/** Local to world: E = x + oE, N = oN - z, H = y + oH. */
export function localToWorld(o: V3): M4 {
  return Float64Array.of(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, o[0], o[1], o[2], 1);
}

/** World to local: x = E - oE, y = H - oH, z = oN - N. */
export function worldToLocal(o: V3): M4 {
  return Float64Array.of(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, -o[0], -o[2], o[1], 1);
}

/**
 * World to the clip box's unit cube: u along the box's east axis, v along its north axis, w up,
 * each divided by the size, so the box is |u|, |v|, |w| <= 0.5.
 */
export function boxInverseWorld(b: ClipBox): M4 {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const [cx, cy, cz] = b.center;
  const [sx, sy, sz] = b.size;
  return Float64Array.of(
    c / sx,
    -s / sy,
    0,
    0,
    s / sx,
    c / sy,
    0,
    0,
    0,
    0,
    1 / sz,
    0,
    -(c * cx + s * cy) / sx,
    (s * cx - c * cy) / sy,
    -cz / sz,
    1,
  );
}
