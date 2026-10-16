import type { Vec3 } from './common';

/**
 * The origin a cloud's file coordinates are taken from, so that y = Z - H + heightOffsetM.
 * A cloud without `heightOffsetM` gets the project origin unchanged.
 */
export function cloudFrameOrigin(origin: Vec3, layer: { heightOffsetM?: number }): Vec3 {
  return [origin[0], origin[1], origin[2] - (layer.heightOffsetM ?? 0)];
}
