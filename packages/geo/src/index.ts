import type { Vec3 } from '@aio/schema';

/**
 * The project frame: a float64 origin in the project CRS. Geometry is rendered relative to it
 * so float32 GPU coordinates stay precise at UTM magnitudes.
 */
export interface ProjectFrame {
  readonly epsg: number;
  readonly origin: Vec3;
  /** Project CRS coordinates to local metres around the origin. */
  toLocal(xyz: Vec3): Vec3;
  /** Local metres back to project CRS coordinates. */
  toProject(local: Vec3): Vec3;
}

export function createFrame(origin: Vec3, epsg: number): ProjectFrame {
  const [ox, oy, oz] = origin;
  return {
    epsg,
    origin,
    toLocal: ([x, y, z]) => [x - ox, y - oy, z - oz],
    toProject: ([x, y, z]) => [x + ox, y + oy, z + oz],
  };
}
