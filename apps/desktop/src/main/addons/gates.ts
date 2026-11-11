/**
 * The `jobs:start` gates of the add-on features (only active when the add-on is installed):
 *
 * - Ground (`pointcloud.clean` mode `noise`): the window asks for ground by sending any `ground`
 *   (`GROUND_REQUEST` in `@aio/schema`). Main never runs what the window sent: it puts the
 *   installed Ground classifier add-on's `classifier.json` `smrf` in its place, or refuses when the
 *   add-on is not installed, or the pipeline pack is older than `POINTCLOUD_GROUND_MIN_PACK` or
 *   the add-on's own `minPipelinePack`. A run without `ground` is left as it is.
 * - `segment.lift`: refused when the pack is older than `SEGMENT_LIFT_MIN_PACK` (or the add-on's
 *   `minPipelinePack`) or the Segmentation add-on is not installed.
 * - A cleanup recipe with a depth band (a region from Classify on point cloud) is saved or
 *   exported only by a pack that reads the band (`SEGMENT_LIFT_MIN_PACK`): an older one would
 *   apply the region through the whole depth of the cloud.
 */
import {
  POINTCLOUD_GROUND_FEATURE,
  POINTCLOUD_GROUND_MIN_PACK,
  SEGMENT_LIFT_FEATURE,
  SEGMENT_LIFT_MIN_PACK,
  type AddonManifest,
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

/** Why an add-on cannot be used with the installed pipeline pack, or null. */
export function packProblem(m: AddonManifest, packVersion: string | null): string | null {
  const min = m.minPipelinePack;
  if (!min || packVersion === 'dev') return null;
  if (packVersion === null)
    return `${m.name} needs processing tools ${min} or later. Install them in Settings, Processing tools.`;
  return compareVersions(packVersion, min) < 0
    ? `${m.name} needs processing tools ${min} or later (these are ${packVersion}). Update them in Settings, Processing tools.`
    : null;
}

/** Does this start request ask a noise run to mark ground? */
export function asksGround(pipeline: string, params: Record<string, unknown>): boolean {
  return pipeline === 'pointcloud.clean' && params.mode === 'noise' && params.ground !== undefined;
}

/** The installed Ground classifier: its settings and its manifest. */
export interface GroundAddon {
  classifier: PointClassifier;
  manifest: AddonManifest;
}

/**
 * The params a `pointcloud.clean` start runs with: `ground` replaced by the add-on's settings, or
 * why the run is refused. Other pipelines and runs without `ground` pass unchanged.
 */
export async function groundGate(
  pipeline: string,
  params: Record<string, unknown>,
  o: { packVersion: string | null; addon: () => Promise<GroundAddon | null> },
): Promise<{ ok: true; params: Record<string, unknown> } | { ok: false; error: string }> {
  if (!asksGround(pipeline, params)) return { ok: true, params };
  if (older(o.packVersion, POINTCLOUD_GROUND_MIN_PACK))
    return {
      ok: false,
      error: tooOld(POINTCLOUD_GROUND_FEATURE, POINTCLOUD_GROUND_MIN_PACK, o.packVersion ?? ''),
    };
  const a = await o.addon();
  if (!a) return { ok: false, error: GROUND_ADDON_MISSING };
  const problem = packProblem(a.manifest, o.packVersion);
  if (problem) return { ok: false, error: problem };
  return { ok: true, params: { ...params, ground: { ...a.classifier.smrf } } };
}

/** Why `segment.lift` may not start, or null. */
export async function liftRefusal(
  pipeline: string,
  o: { packVersion: string | null; segmenter: () => Promise<AddonManifest | null> },
): Promise<string | null> {
  if (pipeline !== 'segment.lift') return null;
  if (older(o.packVersion, SEGMENT_LIFT_MIN_PACK))
    return tooOld(SEGMENT_LIFT_FEATURE, SEGMENT_LIFT_MIN_PACK, o.packVersion ?? '');
  const m = await o.segmenter();
  return m ? packProblem(m, o.packVersion) : LIFT_ADDON_MISSING;
}

/** The pipelines that evaluate a cleanup recipe from their params (the window sends it). */
export const RECIPE_PIPELINES: readonly string[] = ['pointcloud.clean', 'survey.export'];

/** The cleanup recipe a job evaluates: a `pointcloud.clean` save's, or a cloud export's. */
function recipeOf(pipeline: string, params: Record<string, unknown>): unknown {
  if (pipeline === 'pointcloud.clean' && params.mode === 'save') return params.recipe;
  if (pipeline === 'survey.export') return params.cleanup;
  return undefined;
}

const hasDepthBand = (recipe: unknown): boolean => {
  if (typeof recipe !== 'object' || recipe === null) return false;
  const regions = (recipe as { regions?: unknown }).regions;
  return (
    Array.isArray(regions) &&
    regions.some(
      (r) => typeof r === 'object' && r !== null && (r as { depth?: unknown }).depth !== undefined,
    )
  );
};

/** Why a job may not evaluate its recipe's depth bands on the installed pack, or null. */
export function depthBandRefusal(
  pipeline: string,
  params: Record<string, unknown>,
  packVersion: string | null,
): string | null {
  if (!older(packVersion, SEGMENT_LIFT_MIN_PACK) || !hasDepthBand(recipeOf(pipeline, params)))
    return null;
  return `This cleanup has regions from Classify on point cloud, which need processing tools ${SEGMENT_LIFT_MIN_PACK} or later (these are ${packVersion ?? ''}). Update them in Settings, Processing tools.`;
}
