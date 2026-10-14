import type { Vec3 } from '@aio/schema';
import { viewDirection, type ViewPose } from '@aio/video';
import {
  angleDiffDeg,
  bearingOf,
  bearingTo,
  centreOffset,
  distance3,
  groundDistance,
  imagePointOf,
  inFrame,
} from './spotGeom';
import { SPOT_RULES } from './spotRules';
import type {
  FrameSample,
  PanoEntry,
  PhotoEntry,
  Spot,
  SpotEntry,
  SpotMatch,
  VideoEntry,
  WalkEntry,
} from './spotTypes';

/** One matcher per kind (spec table "Rules"). Pure; the search groups and ranks. */
export type Found = Omit<SpotMatch, 'capture'>;

/**
 * Ground-level kinds measure from the spot's camera when it stands on the ground; from its target
 * when the spot is aerial or has no camera (then they must also face the target).
 */
export function groundRef(spot: Spot): { at: Vec3; withCamera: boolean } {
  return spot.camera && !spot.aerial
    ? { at: spot.camera, withCamera: true }
    : { at: spot.target, withCamera: false };
}

const groundScore = (d: number, angle: number | null) =>
  d + SPOT_RULES.angleWeightMPerDeg * (angle ?? 0);

const facing = (a: number | undefined, b: number | undefined): number | null =>
  a === undefined || b === undefined ? null : angleDiffDeg(a, b);

/**
 * How central the target sits in an aerial camera's frame, or null when it does not see it or
 * flies too far off the spot.
 */
function aerialSees(pose: ViewPose, spot: Spot): number | null {
  if (distance3(pose.pos, spot.target) > SPOT_RULES.aerialRangeM) return null;
  if (groundDistance(pose.pos, spot.camera ?? spot.target) > SPOT_RULES.aerialNearM) return null;
  const uv = imagePointOf(pose, spot.target);
  return uv && inFrame(uv) ? centreOffset(uv) : null;
}

export function matchPhoto(spot: Spot, e: PhotoEntry): Found | null {
  if (!e.pos) return null;
  const item = { kind: 'photo', layer: e.layer, photo: e.id } as const;
  const bearing = e.pose ? bearingOf(viewDirection(e.pose.q)) : undefined;
  if (e.pos[1] - spot.target[1] > SPOT_RULES.aerialAboveM) {
    if (!e.pose || !e.hasLens) return null;
    const offset = aerialSees(e.pose, spot);
    if (offset === null) return null;
    return {
      kind: 'drone',
      item,
      aerial: true,
      distanceM: groundDistance(e.pos, spot.camera ?? spot.target),
      angleDeg: facing(bearing, spot.bearingDeg),
      score: offset,
    };
  }
  const ref = groundRef(spot);
  const d = groundDistance(e.pos, ref.at);
  if (d > SPOT_RULES.groundPhotoM) return null;
  const angle = facing(bearing, ref.withCamera ? spot.bearingDeg : bearingTo(e.pos, spot.target));
  if (angle !== null && angle > SPOT_RULES.groundAngleDeg) return null;
  return {
    kind: 'photo',
    item,
    aerial: false,
    distanceM: d,
    angleDeg: angle,
    score: groundScore(d, angle),
  };
}

export function matchPano(spot: Spot, e: PanoEntry): Found | null {
  const d = groundDistance(e.pos, groundRef(spot).at);
  if (d > SPOT_RULES.panoM) return null;
  return {
    kind: 'pano',
    item: { kind: 'pano', layer: e.layer, pano: e.id },
    aerial: false,
    distanceM: d,
    angleDeg: null,
    lookDeg: bearingTo(e.pos, spot.target) ?? spot.bearingDeg ?? e.headingDeg,
    score: d,
  };
}

export function matchWalk(spot: Spot, e: WalkEntry): Found | null {
  if (!e.samples) return null;
  const ref = groundRef(spot);
  let best: Found | null = null;
  for (const s of e.samples) {
    const d = groundDistance(s.pos, ref.at);
    if (d > SPOT_RULES.walkM) continue;
    const angle = ref.withCamera ? null : facing(s.bearingDeg, bearingTo(s.pos, spot.target));
    if (angle !== null && angle > SPOT_RULES.groundAngleDeg) continue;
    const score = groundScore(d, angle);
    if (best && score >= best.score) continue;
    best = {
      kind: 'walk',
      item: { kind: 'walk', layer: e.layer, t: s.t },
      aerial: false,
      distanceM: d,
      angleDeg: angle,
      lookDeg: bearingTo(s.pos, spot.target) ?? spot.bearingDeg ?? s.bearingDeg,
      centreDeg: s.bearingDeg,
      score,
    };
  }
  return best;
}

export function matchVideo(spot: Spot, e: VideoEntry): Found | null {
  if (!e.samples) return null;
  let best: { f: FrameSample; offset: number; d: number } | null = null;
  for (const f of e.samples) {
    const offset = aerialSees(f.pose, spot);
    if (offset === null) continue;
    const d = groundDistance(f.pose.pos, spot.camera ?? spot.target);
    const better =
      !best ||
      offset < best.offset - SPOT_RULES.aerialTie ||
      (Math.abs(offset - best.offset) <= SPOT_RULES.aerialTie && d < best.d);
    if (better) best = { f, offset, d };
  }
  if (!best) return null;
  return {
    kind: 'video',
    item: { kind: 'video', layer: e.layer, t: best.f.t },
    aerial: true,
    distanceM: best.d,
    angleDeg: facing(bearingOf(viewDirection(best.f.pose.q)), spot.bearingDeg),
    score: best.offset,
  };
}

export function matchEntry(spot: Spot, e: SpotEntry): Found | null {
  switch (e.kind) {
    case 'photo':
      return matchPhoto(spot, e);
    case 'pano':
      return matchPano(spot, e);
    case 'walk':
      return matchWalk(spot, e);
    case 'video':
      return matchVideo(spot, e);
  }
}
