import type { Layer, Quat, Vec3 } from '@aio/schema';
import { viewDirection } from '@aio/video';
import type { CaptureIndex } from '@aio/workspace';
import { layerCapture } from '../framesModel';
import { bearingOf, groundAhead, groundHit } from './spotGeom';
import { SPOT_RULES } from './spotRules';
import type { Spot, SpotEntry, SpotItem, SpotOpen, TrackSample } from './spotTypes';

/**
 * The spot of a clicked item (spec "A spot"): its camera, its facing, and where its centre line
 * meets flat ground. High cameras whose centre line meets the origin's ground are aerial; every
 * other view is ground-level, on ground 1.6 m below its camera (a walk: the fit's ground).
 */
export function spotFromLevel(
  pos: Vec3,
  bearingDeg: number | undefined,
  groundY: number,
  dir?: Vec3,
): Spot {
  const target =
    (dir && groundHit(pos, dir, groundY, SPOT_RULES.targetRangeM)) ??
    groundAhead(pos, bearingDeg, groundY, SPOT_RULES.aheadM);
  return {
    camera: pos,
    ...(bearingDeg !== undefined ? { bearingDeg } : {}),
    target,
    aerial: false,
  };
}

export function spotFromPose(pose: { pos: Vec3; q: Quat }): Spot {
  const dir = viewDirection(pose.q);
  const bearingDeg = bearingOf(dir);
  const high = pose.pos[1] - SPOT_RULES.groundY > SPOT_RULES.aerialAboveM;
  const hit = high ? groundHit(pose.pos, dir, SPOT_RULES.groundY, SPOT_RULES.aerialRangeM) : null;
  if (hit)
    return {
      camera: pose.pos,
      ...(bearingDeg !== undefined ? { bearingDeg } : {}),
      target: hit,
      aerial: pose.pos[1] - hit[1] > SPOT_RULES.aerialAboveM,
    };
  return spotFromLevel(pose.pos, bearingDeg, pose.pos[1] - SPOT_RULES.handHeightM, dir);
}

export function spotFromTrack(s: TrackSample, lookDeg?: number): Spot {
  return spotFromLevel(s.pos, lookDeg ?? s.bearingDeg, s.groundY);
}

export function nearestSample<T extends { t: number }>(
  samples: readonly T[] | null | undefined,
  t: number,
): T | undefined {
  let best: T | undefined;
  for (const s of samples ?? []) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return best;
}

/**
 * The survey date an item belongs to, read from its layer (a clip whose flight log or a walk
 * whose files are still being read has no entry yet, but has its date). Undefined for an undated
 * or unknown layer (the item is still found and gets a spot; it has no slot).
 */
export function originCapture(
  item: Pick<SpotItem, 'layer'>,
  layers: readonly Layer[],
  index: CaptureIndex,
): string | undefined {
  const layer = layers.find((l) => l.id === item.layer);
  return layer ? layerCapture(layer, index) : undefined;
}

export function spotOf(open: SpotOpen, entries: readonly SpotEntry[]): Spot | null {
  const { item } = open;
  if (open.pose) return spotFromPose(open.pose);
  for (const e of entries) {
    if (e.layer !== item.layer) continue;
    if (item.kind === 'photo' && e.kind === 'photo' && e.id === item.photo) {
      if (!e.pos) return null;
      return e.pose
        ? spotFromPose(e.pose)
        : spotFromLevel(e.pos, undefined, e.pos[1] - SPOT_RULES.handHeightM);
    }
    if (item.kind === 'pano' && e.kind === 'pano' && e.id === item.pano)
      return spotFromLevel(e.pos, open.lookDeg ?? e.headingDeg, e.pos[1] - SPOT_RULES.handHeightM);
    if (item.kind === 'video' && e.kind === 'video') {
      const f = nearestSample(e.samples, item.t);
      return f ? spotFromPose(f.pose) : null;
    }
    if (item.kind === 'walk' && e.kind === 'walk') {
      const s = nearestSample(e.samples, item.t);
      return s ? spotFromTrack(s, open.lookDeg) : null;
    }
  }
  return null;
}
