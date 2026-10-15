/**
 * The recipe is in world coordinates (project CRS); the stage and its tools in the local frame
 * (x east, y up, z south from the project origin). Conversions for the clip box and the view of a
 * selection. Float64 (three's Matrix4 elements are plain numbers).
 */
import type { ClipBoxLocal } from '@aio/engine';
import { mul4, worldToLocal } from '@aio/pointcloud';
import type { ClipBox } from '@aio/schema';

type V3 = readonly [number, number, number];

export function boxToLocal(b: ClipBox, o: V3): ClipBoxLocal {
  return {
    center: [b.center[0] - o[0], b.center[2] - o[2], o[1] - b.center[1]],
    size: [b.size[0], b.size[1], b.size[2]],
    yaw: b.yaw,
  };
}

export function boxToWorld(l: ClipBoxLocal, o: V3, keep: 'inside' | 'outside'): ClipBox {
  return {
    center: [l.center[0] + o[0], o[1] - l.center[2], l.center[1] + o[2]],
    size: [l.size[0], l.size[1], l.size[2]],
    yaw: l.yaw,
    keep,
  };
}

/** True when two local boxes are the same, number for number. */
export function sameLocalBox(a: ClipBoxLocal, b: ClipBoxLocal): boolean {
  return (
    a.yaw === b.yaw &&
    a.center.every((v, i) => v === b.center[i]) &&
    a.size.every((v, i) => v === b.size[i])
  );
}

/** A selection's view (local to clip) as the recipe stores it (world to clip). */
export function worldViewProj(localViewProj: readonly number[], o: V3): number[] {
  return Array.from(mul4(localViewProj, worldToLocal(o)));
}

/** A box around the layer's bounds (project CRS), 1 % larger, at least 0.1 m a side. */
export function fitBox(b: { min: V3; max: V3 }): ClipBox {
  const size = [0, 1, 2].map((a) =>
    Math.max(0.1, Math.round(((b.max[a] ?? 0) - (b.min[a] ?? 0)) * 1.01 * 1000) / 1000),
  ) as [number, number, number];
  const center = [0, 1, 2].map((a) => ((b.max[a] ?? 0) + (b.min[a] ?? 0)) / 2) as [
    number,
    number,
    number,
  ];
  return { center, size, yaw: 0, keep: 'inside' };
}
