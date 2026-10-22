import type { PointSelection } from '@aio/engine';
import type { TelecomFlagParams, Vec3 } from '@aio/schema';

/**
 * Pure helpers for flagging an antenna: the outline's points are cut to the nearest surface the
 * person sees (the far side of the tower behind a depth gap is dropped), and the job params are
 * built from what is left. Coordinates are stage local, as drawn.
 */

/** A jump in distance from the eye larger than this splits the points into separate surfaces. */
export const FLAG_DEPTH_GAP_M = 0.4;
/** A leading run of fewer points than this is noise in front of the unit and is skipped. */
export const FLAG_MIN_CLUSTER = 8;
/** The kept points' bounds are grown by this on every side. */
export const FLAG_PAD_M = 0.1;
/** Half size of the bounds round the raycast hit when no points were kept. */
const FALLBACK_HALF_M = 0.3;

/**
 * The nearest surface under the outline: points sorted by distance to `eye`, then the first run of
 * at least `FLAG_MIN_CLUSTER` points with no gap over `FLAG_DEPTH_GAP_M` between neighbours.
 * Empty when no run is long enough.
 */
export function nearestCluster(points: Float32Array, eye: Vec3): Float32Array {
  const n = Math.floor(points.length / 3);
  const at = (i: number) => points[i] ?? 0;
  const dist = Array.from({ length: n }, (_, i) =>
    Math.hypot(at(i * 3) - eye[0], at(i * 3 + 1) - eye[1], at(i * 3 + 2) - eye[2]),
  );
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => (dist[a] ?? 0) - (dist[b] ?? 0),
  );
  const depth = (k: number) => dist[order[k] ?? 0] ?? 0;
  let start = 0;
  for (let k = 1; k <= n; k++) {
    if (k < n && depth(k) - depth(k - 1) <= FLAG_DEPTH_GAP_M) continue;
    if (k - start >= FLAG_MIN_CLUSTER) {
      const out = new Float32Array((k - start) * 3);
      for (let j = start; j < k; j++) {
        const i = order[j] ?? 0;
        out.set(points.subarray(i * 3, i * 3 + 3), (j - start) * 3);
      }
      return out;
    }
    start = k;
  }
  return new Float32Array(0);
}

export interface FlagSelection {
  bounds: { min: Vec3; max: Vec3 };
  anchor: Vec3;
}

/**
 * Bounds and anchor of a flag: the kept points' bounds grown by `FLAG_PAD_M` and their mean; with
 * no kept points, `fallback` (the raycast under the outline's centroid) with bounds of ±0.3 m;
 * `null` with neither.
 */
export function flagSelection(kept: Float32Array, fallback: Vec3 | null): FlagSelection | null {
  const n = Math.floor(kept.length / 3);
  if (n === 0) {
    if (!fallback) return null;
    const h = FALLBACK_HALF_M;
    return {
      bounds: {
        min: [fallback[0] - h, fallback[1] - h, fallback[2] - h],
        max: [fallback[0] + h, fallback[1] + h, fallback[2] + h],
      },
      anchor: [fallback[0], fallback[1], fallback[2]],
    };
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const sum: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++)
    for (const c of [0, 1, 2] as const) {
      const v = kept[i * 3 + c] ?? 0;
      min[c] = Math.min(min[c], v);
      max[c] = Math.max(max[c], v);
      sum[c] += v;
    }
  const p = FLAG_PAD_M;
  return {
    bounds: {
      min: [min[0] - p, min[1] - p, min[2] - p],
      max: [max[0] + p, max[1] + p, max[2] + p],
    },
    anchor: [sum[0] / n, sum[1] / n, sum[2] / n],
  };
}

/** A new flagged unit's id: `ant-f-<base36 time>-<4 base36>`. */
export function newFlagId(): string {
  const tail = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `ant-f-${Date.now().toString(36)}-${tail}`;
}

/** The `telecom.flag` job params for an outline drawn on cloud layer `layer`. */
export function flagParams(o: {
  unit: string;
  redraw: boolean;
  layer: string;
  sel: PointSelection;
  bounds: { min: Vec3; max: Vec3 };
  anchor: Vec3;
}): TelecomFlagParams {
  return {
    unit: o.unit,
    ...(o.redraw ? { redraw: true as const } : {}),
    cloud: { layer: o.layer },
    selection: {
      polygon: o.sel.polygon.map(([x, y]) => [x, y] as [number, number]),
      viewProj: [...o.sel.viewProj],
      bounds: { min: [...o.bounds.min], max: [...o.bounds.max] },
      anchor: [...o.anchor],
    },
  };
}
