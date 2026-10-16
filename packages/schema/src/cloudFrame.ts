import type { Vec3 } from './common';
import type { DateShift } from './dateShift';

/**
 * The origin a cloud's file coordinates are taken from, so that y = Z - H + heightOffsetM.
 * A cloud without `heightOffsetM` gets the project origin unchanged. A date shift moves the
 * origin against it (the cloud lies east and north of its file position by the shift).
 */
export function cloudFrameOrigin(
  origin: Vec3,
  layer: { heightOffsetM?: number | undefined },
  shift?: DateShift | null,
): Vec3 {
  return [
    origin[0] - (shift?.eastM ?? 0),
    origin[1] - (shift?.northM ?? 0),
    origin[2] - (layer.heightOffsetM ?? 0),
  ];
}
