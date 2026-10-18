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
/** Picks spread less than this along the face (m, in plan) cannot define its horizontal trace. */
const MIN_TRACE = 0.03;
/** Picks spanning this much height (m) in a well-shaped triangle define the face plane itself. */
const TALL = 0.25;
const WELL_SHAPED = 0.1;
/** Below this shape (twice the area over the longest edge squared) picks give no face plane. */
const MIN_SHAPE = 0.02;
/** Level picks spread this far across their trace (relative to along it) lie on a horizontal face. */
const MAX_ACROSS = 1 / 3;

const HORIZONTAL = 'This face is horizontal. Pick an upright antenna face to determine azimuth.';
const bearing = (x: number, y: number) =>
  ((((Math.atan2(x, y) * 180) / Math.PI) % 360) + 360) % 360;

/**
 * The horizontal unit facing and its clockwise bearing from project/grid north. The face is taken
 * as upright, so picks along a level edge give the facing as the perpendicular to their plan
 * trace; picks spanning real height use the plane through them, which also holds on a tilted face.
 * The side follows the winding (b - a) x (c - a), so flipFace turns the facing round.
 */
export function antennaAzimuth(points: readonly SitePoint[]): Result<{
  bearingDeg: number;
  direction: SitePoint;
  center: SitePoint;
}> {
  const [a, b, c] = points;
  if (points.length !== 3 || !a || !b || !c)
    return invalid('Pick three points along the top or bottom edge of the antenna front face.');
  // Differences avoid summing large project coordinates.
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  const ul = Math.hypot(...u),
    vl = Math.hypot(...v);
  if (!Number.isFinite(ul + vl)) return invalid('Pick points on the 3D model.');
  if (ul <= EPS || vl <= EPS)
    return invalid('Pick three distinct points spread along the antenna face.');
  const nx = u[1] * v[2] - u[2] * v[1];
  const ny = u[2] * v[0] - u[0] * v[2];
  const nz = u[0] * v[1] - u[1] * v[0];
  const shape =
    Math.hypot(nx, ny, nz) /
    Math.max(ul, vl, Math.hypot(v[0] - u[0], v[1] - u[1], v[2] - u[2])) ** 2;
  const center: SitePoint = [
    a[0] + (u[0] + v[0]) / 3,
    a[1] + (u[1] + v[1]) / 3,
    a[2] + (u[2] + v[2]) / 3,
  ];

  // Principal direction of the three picks in plan.
  const me = (u[0] + v[0]) / 3,
    mn = (u[1] + v[1]) / 3;
  const plan = [
    [-me, -mn],
    [u[0] - me, u[1] - mn],
    [v[0] - me, v[1] - mn],
  ] as const;
  let sxx = 0,
    syy = 0,
    sxy = 0;
  for (const [e, n] of plan) {
    sxx += e * e;
    syy += n * n;
    sxy += e * n;
  }
  const angle = Math.atan2(2 * sxy, sxx - syy) / 2;
  const te = Math.cos(angle),
    tn = Math.sin(angle);
  const range = (f: (e: number, n: number) => number) => {
    const s = plan.map(([e, n]) => f(e, n));
    return Math.max(...s) - Math.min(...s);
  };
  const along = range((e, n) => e * te + n * tn);
  const across = range((e, n) => n * te - e * tn);
  const height = Math.max(0, u[2], v[2]) - Math.min(0, u[2], v[2]);

  if (along < MIN_TRACE || (height >= TALL && shape >= WELL_SHAPED)) {
    if (shape <= MIN_SHAPE)
      return invalid(
        'The face points are too close together in plan. Spread them along the face, for example along its top or bottom edge.',
      );
    const horizontal = Math.hypot(nx, ny);
    if (horizontal / Math.hypot(nx, ny, nz) <= EPS) return invalid(HORIZONTAL);
    return {
      ok: true,
      bearingDeg: bearing(nx, ny),
      direction: [nx / horizontal, ny / horizontal, 0],
      center,
    };
  }
  if (across > MAX_ACROSS * along) return invalid(HORIZONTAL);

  // Perpendicular to the trace, on the side the winding gives. Exactly level collinear picks have
  // no winding normal, so the right of b -> c (which flipFace reverses) decides instead.
  let pe = tn,
    pn = -te;
  const side =
    pe * nx + pn * ny || pe * (v[1] - u[1]) - pn * (v[0] - u[0]) || pe * u[1] - pn * u[0];
  if (side < 0) {
    pe = -pe;
    pn = -pn;
  }
  return { ok: true, bearingDeg: bearing(pe, pn), direction: [pe, pn, 0], center };
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
