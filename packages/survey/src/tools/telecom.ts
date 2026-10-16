import type { MeasurementTool, SitePoint } from '@aio/schema';

/** Manual telecom tools use real ENZ picks, with a fixed vertex count. */
export type TelecomTool = 'azimuth' | 'antenna-tilt' | 'clearance';
export const isTelecomTool = (tool: MeasurementTool): tool is TelecomTool =>
  tool === 'azimuth' || tool === 'antenna-tilt' || tool === 'clearance';
export const telecomPointCount = (tool: TelecomTool): number => (tool === 'azimuth' ? 3 : 2);

interface Invalid {
  ok: false;
  message: string;
}
type Result<T> = ({ ok: true } & T) | Invalid;
const invalid = (message: string): Invalid => ({ ok: false, message });
const EPS = 1e-6;

/** The horizontal unit normal and its clockwise bearing from project/grid north. */
export function antennaAzimuth(points: readonly SitePoint[]): Result<{
  bearingDeg: number;
  direction: SitePoint;
  center: SitePoint;
}> {
  const [a, b, c] = points;
  if (points.length !== 3 || !a || !b || !c)
    return invalid('Pick three points across the antenna front face.');
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  const ul = Math.hypot(...u),
    vl = Math.hypot(...v);
  if (ul <= EPS || vl <= EPS)
    return invalid('Pick distinct points spread across the antenna face.');
  const nx = u[1] * v[2] - u[2] * v[1];
  const ny = u[2] * v[0] - u[0] * v[2];
  const nz = u[0] * v[1] - u[1] * v[0];
  const norm = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(norm) || norm / (ul * vl) <= EPS)
    return invalid('The face points are almost in a straight line. Spread them across the face.');
  const horizontal = Math.hypot(nx, ny);
  if (horizontal / norm <= EPS)
    return invalid('This face is horizontal. Pick an upright antenna face to determine azimuth.');
  return {
    ok: true,
    bearingDeg: ((((Math.atan2(nx, ny) * 180) / Math.PI) % 360) + 360) % 360,
    direction: [nx / horizontal, ny / horizontal, 0],
    // Differences avoid summing large project coordinates.
    center: [a[0] + (u[0] + v[0]) / 3, a[1] + (u[1] + v[1]) / 3, a[2] + (u[2] + v[2]) / 3],
  };
}

/** Reversing winding is the persisted facing choice; coordinates remain untouched. */
export function flipFace(points: readonly SitePoint[]): SitePoint[] {
  const [a, b, c] = points;
  return points.length === 3 && a && b && c ? [a, c, b] : [...points];
}

export function clearance(points: readonly SitePoint[]): Result<{
  directM: number;
  horizontalM: number;
  verticalM: number;
}> {
  const [a, b] = points;
  if (points.length !== 2 || !a || !b) return invalid('Pick two endpoints on the 3D model.');
  const horizontalM = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const verticalM = Math.abs(b[2] - a[2]);
  const directM = Math.hypot(horizontalM, verticalM);
  if (!Number.isFinite(directM) || directM <= EPS)
    return invalid('The endpoints coincide. Pick two distinct points on the 3D model.');
  return { ok: true, directM, horizontalM, verticalM };
}

/** Unsigned physical inclination from project vertical, independent of click order. */
export function antennaTilt(points: readonly SitePoint[]): Result<{ angleDeg: number }> {
  const gap = clearance(points);
  return gap.ok
    ? { ok: true, angleDeg: (Math.atan2(gap.horizontalM, gap.verticalM) * 180) / Math.PI }
    : gap;
}

export function telecomProblem(tool: TelecomTool, points: readonly SitePoint[]): string | null {
  const result =
    tool === 'azimuth'
      ? antennaAzimuth(points)
      : tool === 'antenna-tilt'
        ? antennaTilt(points)
        : clearance(points);
  return result.ok ? null : result.message;
}
