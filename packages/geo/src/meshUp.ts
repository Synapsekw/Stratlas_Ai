import type { Mat4, Vec3 } from '@aio/schema';
import {
  applyMat4,
  fitSimilarity3D,
  type PointPair,
  type SimilarityFit,
  type SimilarityMode,
} from './similarity';

/**
 * Which model axis points up. glTF is Y up; Pix4D and survey software write Z up (x east, y north,
 * z up). The answer is never stored: the mesh layer `transform` carries the turn
 * (data-conventions section 1) and `upAxisOf` reads it back.
 */
export type UpAxis = 'y' | 'z';

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Z up to the scene frame (x east, y up, z south): (x, y, z) becomes (x, z, -y). */
export const Z_UP: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const Z_UP_INV: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

/** `a × b` for column-major 4x4 matrices (three.js `Matrix4.elements` order). */
export function mulMat4(a: readonly number[], b: readonly number[]): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = s;
    }
  return out;
}

/** A Z-up model stood upright with its model origin at `at` (local frame). */
export function placeZUp(at: Vec3): Mat4 {
  return [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, at[0], at[1], at[2], 1];
}

/** The model axis the transform turns closest to scene up: `z` when model z points up. */
export function upAxisOf(t: readonly number[]): UpAxis {
  const y = t[5] ?? 0;
  const z = t[9] ?? 0;
  return z > Math.max(y, 0) ? 'z' : 'y';
}

/** The transform with the model turned to `up` about its own origin; everything else kept. */
export function withUpAxis(t: readonly number[], up: UpAxis): Mat4 {
  if (upAxisOf(t) === up) return [...t];
  return mulMat4(t, up === 'z' ? Z_UP : Z_UP_INV);
}

/**
 * Point-pair fit for a model whose up axis is `up`: the pairs' model points are turned upright
 * first, so a Level fit (turn about the vertical only) keeps a Z-up model standing; the fit's
 * matrix includes the turn.
 */
export function fitModelPlacement(
  pairs: readonly PointPair[],
  mode: SimilarityMode,
  opts: { heightOffset?: number },
  up: UpAxis,
): SimilarityFit {
  if (up === 'y') return fitSimilarity3D(pairs, mode, opts);
  const f = fitSimilarity3D(
    pairs.map((p) => ({ ...p, src: applyMat4(Z_UP, p.src) })),
    mode,
    opts,
  );
  return { ...f, matrix: mulMat4(f.matrix, Z_UP) };
}
