import type { FlightHeights, LensModel, PoseSample, Quat, Vec3 } from '@aio/schema';
import type { AioFlight } from './flight';
import { composeFrame, mapPoint, mapQuat, rotateY, type FrameMap } from './frames';
import { applySimilarity2D, type Similarity2D } from './fit';
import { quatFromAxisAngle, quatMultiply, quatNormalize, round, roundVec } from './math';

/**
 * Al-Zour plant twin frame (plant.glb scene): x = plant E - 1300, y = EL - 100, z = -(plant N - 450).
 * Plant azimuths are clockwise from plant north (-z).
 */
export const PLANT_E0 = 1300;
export const PLANT_N0 = 450;
export const PLANT_EL0 = 100;

export const plantToScene = (e: number, n: number, el: number): Vec3 => [
  e - PLANT_E0,
  el - PLANT_EL0,
  -(n - PLANT_N0),
];

/**
 * Map from the plant scene frame into the project local frame for a rigid plant grid to UTM
 * fit and a project origin [E, N, H] (H on the plant datum, so local y = EL - origin[2]).
 */
export function plantFrame(fit: Similarity2D, origin: Vec3): FrameMap {
  const [e0, n0] = applySimilarity2D(fit, [PLANT_E0, PLANT_N0]);
  // A counter-clockwise turn by theta in (E, N) is a turn by theta about +Y in (x, y, -z).
  return composeFrame(rotateY(fit.thetaDeg), [
    e0 - origin[0],
    PLANT_EL0 - origin[2],
    -(n0 - origin[1]),
  ]);
}

/** three.js Euler (x, y, z, 'YXZ') in degrees to a quaternion: q = qY * qX * qZ. */
export function eulerYXZ(xDeg: number, yDeg: number, zDeg: number): Quat {
  const r = Math.PI / 180;
  const qx = quatFromAxisAngle([1, 0, 0], xDeg * r);
  const qy = quatFromAxisAngle([0, 1, 0], yDeg * r);
  const qz = quatFromAxisAngle([0, 0, 1], zDeg * r);
  return quatMultiply(quatMultiply(qy, qx), qz);
}

/**
 * Camera orientation the Al-Zour viewer uses for a plant azimuth (deg clockwise from plant north),
 * pitch (deg, negative looks down) and roll: Euler(pitch, -az, -roll, 'YXZ') in the plant scene.
 */
export const plantCameraQuat = (azDeg: number, pitchDeg: number, rollDeg = 0): Quat =>
  eulerYXZ(pitchDeg, -azDeg, -rollDeg);

/**
 * One clip of the plant twin `flights.json`. Track rows: E, N, EL, az, gimbal pitch, drone pitch,
 * drone roll. The track's EL is `100 + relative altitude` (the artifact assumed every take-off at
 * plant grade, EL 100); `abs_minus_rel` is the aircraft's absolute minus relative altitude (the
 * take-off point's absolute altitude, constant per flight).
 */
export interface PlantVideo {
  flight: number;
  created: string;
  dur: number;
  hz: number;
  track: number[][];
  alt_rel_start?: number | undefined;
  abs_minus_rel?: number | undefined;
}

/** Take-off EL the artifact assumed for the track's EL column (plant grade). */
export const TRACK_TAKEOFF_EL = 100;

/**
 * Plant EL = DJI absolute altitude + 100 m at Al-Zour. Found by M6 stream A1: with EL = 100 +
 * relative altitude every flight sat 20 to 44 m too low against the plant model, by exactly its
 * `abs_minus_rel` (41.9, 32.2, 28.4, 25.6, 22.7 m for flights 1 to 5), so the DJI absolute
 * altitude and the plant datum agree up to this constant there. The take-offs were not at grade.
 */
export const ALZOUR_ABS_TO_EL = 100;

/** The height rule of the Al-Zour clips: absolute altitude on the plant datum. */
export const ALZOUR_HEIGHTS: FlightHeights = {
  source: 'absolute',
  absOffsetM: ALZOUR_ABS_TO_EL,
  takeoffH: TRACK_TAKEOFF_EL,
};

/** The rule of imports before the fix: take-off at plant grade plus relative altitude. */
export const LEGACY_HEIGHTS: FlightHeights = {
  source: 'relative',
  absOffsetM: ALZOUR_ABS_TO_EL,
  takeoffH: TRACK_TAKEOFF_EL,
};

/**
 * Metres to add to a clip track's EL column for a height rule, and the source it ends up with.
 * Relative: `EL = takeoffH + rel`; absolute: `EL = rel + abs_minus_rel + absOffsetM` (a clip
 * without `abs_minus_rel` falls back to relative).
 */
export function trackElShift(
  v: Pick<PlantVideo, 'abs_minus_rel'>,
  h: FlightHeights,
): { shift: number; source: 'absolute' | 'relative' } {
  if (h.source !== 'relative' && v.abs_minus_rel !== undefined)
    return { shift: v.abs_minus_rel + (h.absOffsetM - TRACK_TAKEOFF_EL), source: 'absolute' };
  return { shift: h.takeoffH - TRACK_TAKEOFF_EL, source: 'relative' };
}

/**
 * Convert a clip track to `aio.flight/1`. Sample i is at clip time i / hz; the camera is the
 * stabilised heading plus gimbal pitch (no roll), as in the original viewer. `elShiftM` is added
 * to the track's EL ({@link trackElShift}).
 */
export function plantVideoToFlight(
  v: PlantVideo,
  frame: FrameMap,
  startUtcMs: number,
  lens: LensModel,
  name?: string,
  elShiftM = 0,
): AioFlight {
  const samples: PoseSample[] = [];
  for (const [i, row] of v.track.entries()) {
    const [e = 0, n = 0, el = 0, az = 0, gp = 0] = row;
    samples.push({
      t: Math.round((i / v.hz) * 1000),
      pos: roundVec(mapPoint(frame, plantToScene(e, n, el + elShiftM)), 3),
      q: roundVec(quatNormalize(mapQuat(frame, plantCameraQuat(az, gp))), 6),
      gimbal: { pitch: round(gp, 2), yaw: round(az, 2), roll: 0 },
    });
  }
  const doc: AioFlight = { schema: 'aio.flight/1', startUtcMs, lens, samples };
  if (name) doc.name = name;
  return doc;
}

/**
 * DJI writes the local wall-clock time with a "Z" suffix. Kuwait is UTC+3 all year.
 */
export function djiLocalToUtcMs(created: string, utcOffsetH = 3): number {
  const ms = Date.parse(created.endsWith('Z') ? created : `${created}Z`);
  if (Number.isNaN(ms)) throw new Error(`Bad time ${created}`);
  return ms - utcOffsetH * 3_600_000;
}
