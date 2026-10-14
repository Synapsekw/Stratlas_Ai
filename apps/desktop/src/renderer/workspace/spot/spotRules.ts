import { PAIR_MAX_M } from '../panoPair';
import type { SpotItem } from './spotTypes';

/**
 * Spot history tolerances (spec "The search", starting values). The only place a tolerance is
 * written; tune them here. Distances in metres (horizontal), angles in degrees.
 */
export const SPOT_RULES = {
  /** A ground photo is the same spot when its camera is this close... */
  groundPhotoM: 15,
  /** ...and it faces within this angle (walk frames from a map click too). */
  groundAngleDeg: 45,
  /** A 360 panorama: camera this close, facing does not matter (as the T3 pairing). */
  panoM: PAIR_MAX_M,
  /** A walk frame: the nearest frame of a placed walk this close. */
  walkM: 15,
  /** A camera more than this far above the target is aerial (drone photos, video). */
  aerialAboveM: 10,
  /** Videos are sampled this often, seconds. */
  videoStepS: 1,
  /** Placed walks are sampled this often, seconds. */
  walkStepS: 1,
  /** Ranking of ground-level matches: metres that one degree of facing weighs. */
  angleWeightMPerDeg: 0.2,
  /** Aerial matches whose target lies this close to equally central count as a tie. */
  aerialTie: 0.01,
  /** An aerial camera sees a target up to this far, metres (as `groundFootprint`). */
  aerialRangeM: 300,
  /**
   * ...and only a drone camera this close to the spot's camera (its target without one), metres
   * horizontal, is the same spot: a far-off oblique view is a different picture (founder, 14 Oct).
   */
  aerialNearM: 50,
  /** Height of the ground under aerial views: the project origin's, as `@aio/video` pairing. */
  groundY: 0,
  /** A hand-held camera (photo, 360) stands this high above its ground. */
  handHeightM: 1.6,
  /** A ground-level centre line that meets its ground within this range aims there... */
  targetRangeM: 30,
  /** ...else it aims this far ahead along its bearing. */
  aheadM: 15,
  /** A view direction with less than this horizontal share has no bearing (straight down). */
  minHorizontal: 0.1,
} as const;

/** The radius an empty slot names for a spot opened from this kind ("Nothing within 15 m"). */
export function slotRadiusM(kind: SpotItem['kind']): number {
  return kind === 'pano'
    ? SPOT_RULES.panoM
    : kind === 'walk'
      ? SPOT_RULES.walkM
      : SPOT_RULES.groundPhotoM;
}
