/**
 * The `jobs:start` gates of the add-on features (only active when the add-on is installed):
 *
 * - Ground (`pointcloud.clean` mode `noise`): the window asks for ground by sending any `ground`
 *   (`GROUND_REQUEST` in `@aio/schema`). Main never runs what the window sent: it puts the
 *   installed Ground classifier add-on's `classifier.json` `smrf` in its place, or refuses when the
 *   add-on is not installed or the pipeline pack is older than `POINTCLOUD_GROUND_MIN_PACK`. A run
 *   without `ground` is left as it is.
 * - `segment.lift`: refused when the pack is older than `SEGMENT_LIFT_MIN_PACK` or the Segmentation
 *   add-on is not installed.
 */
import {
  POINTCLOUD_GROUND_FEATURE,
  POINTCLOUD_GROUND_MIN_PACK,
  SEGMENT_LIFT_FEATURE,
  SEGMENT_LIFT_MIN_PACK,
  type PointClassifier,
} from '@aio/schema';
import { compareVersions } from '../jobs/pack';

export const GROUND_PACK_FEATURE = {
  label: POINTCLOUD_GROUND_FEATURE,
  minVersion: POINTCLOUD_GROUND_MIN_PACK,
};
export const LIFT_PACK_FEATURE = { label: SEGMENT_LIFT_FEATURE, minVersion: SEGMENT_LIFT_MIN_PACK };

export const GROUND_ADDON_MISSING =
  'Install the Ground classifier add-on in Settings, Models and detection to mark ground points.';
export const LIFT_ADDON_MISSING =
  'Install the Segmentation add-on in Settings, Models and detection to classify a point cloud from photo masks.';

const tooOld = (feature: string, min: string, version: string) =>
  `${feature} needs processing tools ${min} or later (these are ${version}). Update them in Settings, Processing tools.`;

const older = (version: string | null, min: string) =>
  version !== null && version !== 'dev' && compareVersions(version, min) < 0;

/** Does this start request ask a noise run to mark ground? */
export function asksGround(pipeline: string, params: Record<string, unknown>): boolean {
  return pipeline === 'pointcloud.clean' && params.mode === 'noise' && params.ground !== undefined;
}

/**
 * The params a `pointcloud.clean` start runs with: `ground` replaced by the add-on's settings, or
 * why the run is refused. Other pipelines and runs without `ground` pass unchanged.
 */
export async function groundGate(
  pipeline: string,
  params: Record<string, unknown>,
  o: { packVersion: string | null; classifier: () => Promise<PointClassifier | null> },
): Promise<{ ok: true; params: Record<string, unknown> } | { ok: false; error: string }> {
  if (!asksGround(pipeline, params)) return { ok: true, params };
  if (older(o.packVersion, POINTCLOUD_GROUND_MIN_PACK))
    return {
      ok: false,
      error: tooOld(POINTCLOUD_GROUND_FEATURE, POINTCLOUD_GROUND_MIN_PACK, o.packVersion ?? ''),
    };
  const c = await o.classifier();
  if (!c) return { ok: false, error: GROUND_ADDON_MISSING };
  return { ok: true, params: { ...params, ground: { ...c.smrf } } };
}

/** Why `segment.lift` may not start, or null. */
export async function liftRefusal(
  pipeline: string,
  o: { packVersion: string | null; segmenterInstalled: () => Promise<boolean> },
): Promise<string | null> {
  if (pipeline !== 'segment.lift') return null;
  if (older(o.packVersion, SEGMENT_LIFT_MIN_PACK))
    return tooOld(SEGMENT_LIFT_FEATURE, SEGMENT_LIFT_MIN_PACK, o.packVersion ?? '');
  return (await o.segmenterInstalled()) ? null : LIFT_ADDON_MISSING;
}
