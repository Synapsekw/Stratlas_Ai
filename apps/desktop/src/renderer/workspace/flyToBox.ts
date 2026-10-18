import type { Vec3 } from '@aio/schema';
import { workspace } from '@aio/workspace';

/** The axis-aligned box around local-frame points, grown by `pad` metres on every side. */
export function boxOfPoints(points: readonly Vec3[], pad = 0.5): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i] ?? 0, p[i] ?? 0);
      max[i] = Math.max(max[i] ?? 0, p[i] ?? 0);
    }
  }
  return {
    min: [min[0] - pad, min[1] - pad, min[2] - pad],
    max: [max[0] + pad, max[1] + pad, max[2] + pad],
  };
}

/** Fly the 3D camera to frame local-frame points. */
export function flyToLocalBox(points: readonly Vec3[], pad?: number): void {
  if (points.length === 0) return;
  const { min, max } = boxOfPoints(points, pad);
  workspace.getState().flyTo({ kind: 'box', min, max });
}
