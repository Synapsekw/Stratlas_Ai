import { shiftLocal, type ProjectManifest } from '@aio/schema';
import { percentile } from '../builder/dropToGround';
import { drapeStations, type GroundAt } from './walkGround';
import type { SheetWalk } from './walkOverlay';
import { sceneRuns } from './walkScene';

/*
 * Drop to ground for a walk: the floor drawn in 3D is asked under the walk's path (the walk ground's
 * sampler, near the walk's stored ground, so a roof over the walker is skipped and a cloud's floor
 * answers before the ortho plane under it), and the walk moves by the median of the differences
 * between that floor and its ground (its pins' heights plus its offset). Misses are left out; a
 * few stray answers (a step, a table, a roof the pins stood on) do not move the median.
 */

type Pt = readonly [number, number, number];

/** Fewer floor answers than this under a walk: nothing to drop it onto. */
export const MIN_WALK_FLOOR_HITS = 3;
/** The floor is asked at most this many times along one walk (rays down a model are not cheap). */
export const MAX_WALK_FLOOR_ASKS = 400;

/**
 * How far the floor lies over the walk's ground along `runs` (scene points whose y is the walk's
 * ground there): the median of `floor - y` over the stations about every metre along the runs
 * (`drapeStations`), evenly thinned to at most `maxAsks`; null with fewer than
 * `MIN_WALK_FLOOR_HITS` answers.
 */
export function walkFloorShift(
  runs: readonly (readonly Pt[])[],
  ground: GroundAt,
  maxAsks: number = MAX_WALK_FLOOR_ASKS,
): { shift: number; hits: number } | null {
  const pts: Pt[] = [];
  for (const r of runs) for (const i of drapeStations(r)) if (r[i]) pts.push(r[i]);
  const every = Math.max(1, Math.ceil(pts.length / Math.max(1, Math.floor(maxAsks))));
  const diffs: number[] = [];
  for (let k = 0; k < pts.length; k += every) {
    const p = pts[k];
    if (!p || !Number.isFinite(p[1])) continue;
    const y = ground(p[0], p[2], p[1]);
    if (y !== null && Number.isFinite(y)) diffs.push(y - p[1]);
  }
  if (diffs.length < MIN_WALK_FLOOR_HITS) return null;
  const shift = percentile(diffs, 0.5);
  return shift === null ? null : { shift, hits: diffs.length };
}

/**
 * The placed walk's fit as the views drew it last, for the manifest `m` (null: not fitted for it).
 * `placeWalk.ts` fills it in, so Drop to ground does not load the walks' whole module.
 */
export const walkFitSource: {
  now: (m: ProjectManifest, layerId: string) => SheetWalk | null;
} = { now: () => null };

/** A placed walk's path in the scene, at its ground (unlifted), its date's shift applied. */
export function walkScenePath(w: SheetWalk): [number, number, number][][] {
  return sceneRuns(w.fit, w.layer.durationS, 0.25, 0).map((r) =>
    r.pts.map((p) => shiftLocal(p, w.shift ?? null)),
  );
}
