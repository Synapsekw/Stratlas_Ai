/**
 * Antenna geometry (spec D15): the direction to a point in the antenna's own frame.
 *
 * Frames, all right-handed, metres:
 * - grid: the project CRS axes. `east` along grid east, `north` along grid north, `up` vertical.
 * - true: east, true north, up. A grid vector turns clockwise by the convergence:
 *   true bearing = grid bearing + convergenceDeg (the same rule as true azimuth = grid azimuth + convergence).
 * - antenna: `forward` along the (mechanically tilted) boresight, `right` along the horizontal tilt
 *   axis to the right of boresight, `up` the antenna's own up.
 *
 * The antenna frame is reached by turning by the true azimuth about the vertical, then by the
 * mechanical downtilt about the antenna's horizontal axis. Mechanical tilt is that rotation and is
 * never added to the electrical tilt, which lives in the pattern's vertical cut (pattern.ts).
 *
 * Angles: bearings and azimuths in degrees clockwise from north. Downtilt and `downElevationDeg`
 * are positive below (beam pointing down). In 38.901's zenith convention theta = 90 + downElevation.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export interface Enu {
  east: number;
  north: number;
  up: number;
}

export interface AntennaOrientation {
  /** Degrees clockwise from true north. */
  trueAzimuthDeg: number;
  /** Mechanical downtilt, degrees, positive down. */
  mechanicalDowntiltDeg: number;
}

export interface GridAntennaOrientation {
  /** Degrees clockwise from grid north (`azimuthGridDeg` in the antenna inventory file, `telecom/antennas.json`). */
  azimuthGridDeg: number;
  /** True azimuth = grid azimuth + convergence. Null when the project has no CRS. */
  convergenceDeg: number | null;
  /** Mechanical downtilt, degrees, positive down. */
  mechanicalDowntiltDeg: number;
}

export interface AntennaFrameDirection {
  /** Unit vector components in the antenna frame. */
  forward: number;
  right: number;
  up: number;
  /** Horizontal angle off boresight, (-180, 180], positive clockwise (to the right). */
  azimuthDeg: number;
  /** Angle below the antenna's boresight plane, [-90, 90], positive down. */
  downElevationDeg: number;
}

export function normalizeDeg360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Wraps to (-180, 180]. */
export function normalizeDeg180(deg: number): number {
  const d = normalizeDeg360(deg);
  return d > 180 ? d - 360 : d;
}

/** Bearing of a vector's horizontal part, degrees clockwise from its frame's north, [0, 360). */
export function bearingDeg(v: Enu): number {
  return normalizeDeg360(Math.atan2(v.east, v.north) * DEG);
}

/** True azimuth = grid azimuth + convergence, [0, 360). Throws without a convergence (spec D2). */
export function trueAzimuthDeg(azimuthGridDeg: number, convergenceDeg: number | null): number {
  if (convergenceDeg === null || !Number.isFinite(convergenceDeg)) {
    throw new Error(
      'No grid convergence: the project needs a CRS before coverage can face the right way',
    );
  }
  return normalizeDeg360(azimuthGridDeg + convergenceDeg);
}

/** Turns a grid-frame vector into the true frame (clockwise by the convergence). */
export function gridToTrue(v: Enu, convergenceDeg: number): Enu {
  const c = Math.cos(convergenceDeg * RAD);
  const s = Math.sin(convergenceDeg * RAD);
  return { east: v.east * c + v.north * s, north: v.north * c - v.east * s, up: v.up };
}

/** Direction (true frame, any length) into the antenna frame. Throws for a zero vector. */
export function toAntennaFrame(dirTrue: Enu, o: AntennaOrientation): AntennaFrameDirection {
  const len = Math.hypot(dirTrue.east, dirTrue.north, dirTrue.up);
  if (!(len > 0) || !Number.isFinite(len))
    throw new Error('Direction must be a finite, non-zero vector');
  const e = dirTrue.east / len;
  const n = dirTrue.north / len;
  const u = dirTrue.up / len;

  // 1. Turn by the true azimuth: f along the horizontal boresight, r to its right.
  const sa = Math.sin(o.trueAzimuthDeg * RAD);
  const ca = Math.cos(o.trueAzimuthDeg * RAD);
  const f = e * sa + n * ca;
  const r = e * ca - n * sa;

  // 2. Tilt down by t about the right axis: boresight (cos t, 0, -sin t) and antenna up
  //    (sin t, 0, cos t) in (f, r, u).
  const st = Math.sin(o.mechanicalDowntiltDeg * RAD);
  const ct = Math.cos(o.mechanicalDowntiltDeg * RAD);
  const forward = f * ct - u * st;
  const up = f * st + u * ct;

  const azimuthDeg = normalizeDeg180(Math.atan2(r, forward) * DEG);
  const downElevationDeg = -Math.atan2(up, Math.hypot(forward, r)) * DEG;
  return { forward, right: r, up, azimuthDeg, downElevationDeg: downElevationDeg + 0 };
}

/**
 * Grid offset from the antenna to the point (project CRS, metres) into the antenna frame, from the
 * measured grid azimuth, convergence and mechanical downtilt. The convergence turns both the
 * azimuth and the direction, so it cancels here; it matters wherever one side is true and the other
 * grid, which is why both always go through it.
 */
export function directionToAntennaFrame(
  directionGrid: Enu,
  o: GridAntennaOrientation,
): AntennaFrameDirection {
  const az = trueAzimuthDeg(o.azimuthGridDeg, o.convergenceDeg);
  return toAntennaFrame(gridToTrue(directionGrid, o.convergenceDeg ?? 0), {
    trueAzimuthDeg: az,
    mechanicalDowntiltDeg: o.mechanicalDowntiltDeg,
  });
}
