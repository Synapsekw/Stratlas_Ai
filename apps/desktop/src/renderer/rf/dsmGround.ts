/**
 * The DSM ground near a tower base for the RF store (`setDsmGroundProvider`, spec D4), done the
 * job's way (python `rf/inputs.py` `ground_from_dsm`): the `DSM_GROUND_PERCENTILE` (5th)
 * percentile of the DSM within `DSM_GROUND_RADIUS_M` (30 m) of the base, from the first DSM that
 * covers it; never the DSM at the one point (that is the tower top) and never terrain.
 *
 * The renderer reads the DSM where the 3D view draws it: `sample(x, z, layerId)` is the height
 * straight down onto one DSM layer in the local frame, or null off it (the shell's `rayDown`).
 * A point the DSM has not loaded under yet answers null and is asked again later. The caller moves
 * the base by the inventory's line-up shift first, so it is sampled where the tower is drawn.
 */
import { DSM_GROUND_PERCENTILE, DSM_GROUND_RADIUS_M } from '@aio/rf';
import type { Vec3 } from '@aio/schema';
import { percentile } from '../builder/dropToGround';
import type { DsmGroundAt } from './rfModel';

/** Sample spacing inside the disc, metres (the job reads every DSM pixel; this is close enough). */
export const DSM_GROUND_STEP_M = 2;
/** At least this many hits before the percentile is trusted. */
export const DSM_GROUND_MIN_HITS = 20;
/** A miss is asked again after this long (the DSM may still be loading). */
const RETRY_MS = 3000;

/** The DSM ground at one base from a height sampler over one layer; null when it does not cover it. */
export function dsmGroundAt(
  east: number,
  north: number,
  origin: Vec3,
  sample: (x: number, z: number) => number | null,
): number | null {
  const hits: number[] = [];
  const r = DSM_GROUND_RADIUS_M;
  const x0 = east - origin[0];
  const z0 = -(north - origin[1]);
  for (let dx = -r; dx <= r; dx += DSM_GROUND_STEP_M)
    for (let dz = -r; dz <= r; dz += DSM_GROUND_STEP_M) {
      if (dx * dx + dz * dz > r * r) continue;
      const y = sample(x0 + dx, z0 + dz);
      if (y !== null && Number.isFinite(y)) hits.push(y);
    }
  if (hits.length < DSM_GROUND_MIN_HITS) return null;
  // the same linear percentile as Drop to ground (numpy's default), as a fraction
  const y = percentile(hits, DSM_GROUND_PERCENTILE / 100);
  return y === null ? null : y + origin[2];
}

/**
 * A provider over the project's DSM layers in manifest order (the first that covers a base wins),
 * remembering each base's answer; a miss is asked again after a while.
 */
export function dsmGroundProvider(
  dsmLayers: readonly string[],
  origin: Vec3,
  sample: (x: number, z: number, layerId: string) => number | null,
  now: () => number = () => Date.now(),
): DsmGroundAt {
  const known = new Map<string, number>();
  const missed = new Map<string, number>();
  return (east, north) => {
    const key = `${east.toFixed(2)},${north.toFixed(2)}`;
    const hit = known.get(key);
    if (hit !== undefined) return hit;
    const at = missed.get(key);
    if (at !== undefined && now() - at < RETRY_MS) return null;
    for (const id of dsmLayers) {
      const g = dsmGroundAt(east, north, origin, (x, z) => sample(x, z, id));
      if (g !== null) {
        known.set(key, g);
        missed.delete(key);
        return g;
      }
    }
    missed.set(key, now());
    return null;
  };
}
