import { z } from 'zod';
import { Id, ProjectPath } from './common';

/*
 * Point cloud cleanup (spec docs/plans/2026-10-15-pointcloud-cleanup-design.md): one recipe per
 * point cloud layer in `edits/pointcloud/<layerId>.json` (`aio.pccleanup/1`), evaluated live in the
 * viewer (`@aio/pointcloud` cleanup/evaluate.ts) and over the full cloud in the pipeline
 * (python `aio_pipelines/pointcloud_cleanup/evaluate.py`). Coordinates are world: the project CRS,
 * like the COPC header. Nothing here imports `jobs.ts` (it imports this file).
 */

export const PCCLEANUP_SCHEMA = 'aio.pccleanup/1';
export const PCCLEANUP_DIR = 'edits/pointcloud';
export const MAX_REGIONS = 200;
export const MAX_LASSO_VERTICES = 256;
/** ASPRS class 7 (low noise): what the noise filters mark. */
export const NOISE_CLASS = 7;

/** The first pipeline pack with `pointcloud.clean`; one constant, set at merge time (0.10.0 or 0.11.0). */
export const POINTCLOUD_CLEAN_MIN_PACK = '0.10.0';
export const POINTCLOUD_CLEAN_FEATURE = 'Point cloud noise removal and cleaned copies';

export const DEFAULT_OUTLIER = { meanK: 8, multiplier: 2 } as const;
export const DEFAULT_ELM = { cell: 10, threshold: 1 } as const;

export const pccleanupPath = (layerId: string): string => `${PCCLEANUP_DIR}/${layerId}.json`;
export const noiseCopyPath = (layerId: string, runId: string): string =>
  `${PCCLEANUP_DIR}/${layerId}.noise-${runId}.copc.laz`;
export const noiseRunPath = (layerId: string, runId: string): string =>
  `${PCCLEANUP_DIR}/${layerId}.noise-${runId}.json`;

/** A job id (same rule as `JobId` in jobs.ts, repeated to keep this file free of jobs.ts). */
const RunId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, 'Not a valid job id');
const V3 = z.tuple([z.number(), z.number(), z.number()]);
const Size = z.number().min(0.01).max(1e6);
const ClassCode = z.number().int().min(0).max(255);
/** NDC of a selection vertex; a lasso may leave the view a little. */
const Ndc = z.tuple([z.number().min(-100).max(100), z.number().min(-100).max(100)]);

export const ClipBox = z
  .object({
    /** World centre [E, N, H]. */
    center: V3,
    /** Extent along the box's east, north and up axes, metres. */
    size: z.tuple([Size, Size, Size]),
    /** Radians about +Z, counter-clockwise seen from above (east toward north). */
    yaw: z.number().min(-10).max(10),
    keep: z.enum(['inside', 'outside']),
  })
  .strict();
export type ClipBox = z.infer<typeof ClipBox>;

export const HeightRange = z
  .object({ min: z.number().optional(), max: z.number().optional() })
  .strict()
  .refine((h) => h.min === undefined || h.max === undefined || h.min <= h.max, {
    message: 'The lowest height is above the highest.',
  });
export type HeightRange = z.infer<typeof HeightRange>;

export const RegionAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hide') }).strict(),
  z.object({ kind: z.literal('delete') }).strict(),
  z.object({ kind: z.literal('class'), value: ClassCode }).strict(),
]);
export type RegionAction = z.infer<typeof RegionAction>;

export const CleanupRegion = z
  .object({
    id: z.string().min(1).max(64),
    shape: z.enum(['box', 'lasso']),
    /** World to clip, column-major, as the view was when the region was drawn. */
    viewProj: z.array(z.number()).length(16),
    /** NDC vertices: 4 corners for a box, 3 to 256 for a lasso. */
    polygon: z.array(Ndc).min(3).max(MAX_LASSO_VERTICES),
    action: RegionAction,
  })
  .strict()
  .refine((r) => r.shape !== 'box' || r.polygon.length === 4, {
    message: 'A box selection has 4 corners.',
  });
export type CleanupRegion = z.infer<typeof CleanupRegion>;

export const OutlierParams = z
  .object({
    meanK: z.number().int().min(2).max(64),
    multiplier: z.number().min(0.1).max(10),
  })
  .strict();
export const ElmParams = z
  .object({ cell: z.number().min(0.5).max(100), threshold: z.number().min(0.1).max(50) })
  .strict();
export const NoiseParams = z.object({ outlier: OutlierParams, elm: ElmParams.optional() }).strict();
export type NoiseParams = z.infer<typeof NoiseParams>;

/** A noise run: its working copy, the settings, what it marked. Also the record file beside the copy. */
export const NoiseRun = z
  .object({
    path: ProjectPath.refine(
      (p) => p.startsWith(`${PCCLEANUP_DIR}/`) && p.endsWith('.copc.laz'),
      'A noise working copy lives in edits/pointcloud and is a COPC file',
    ),
    params: NoiseParams,
    marked: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    runId: RunId,
  })
  .strict();
export type NoiseRun = z.infer<typeof NoiseRun>;

export const PointcloudCleanup = z
  .object({
    schema: z.literal(PCCLEANUP_SCHEMA),
    layerId: Id,
    clipBox: ClipBox.optional(),
    height: HeightRange.optional(),
    hiddenClasses: z
      .array(ClassCode)
      .max(256)
      .refine((a) => new Set(a).size === a.length, 'A class is listed twice'),
    regions: z.array(CleanupRegion).max(MAX_REGIONS),
    noise: NoiseRun.optional(),
  })
  .strict();
export type PointcloudCleanup = z.infer<typeof PointcloudCleanup>;

export function emptyCleanup(layerId: string): PointcloudCleanup {
  return { schema: PCCLEANUP_SCHEMA, layerId, hiddenClasses: [], regions: [] };
}

/** True when the recipe changes nothing in the view, a save or an export. */
export function isEmptyCleanup(r: PointcloudCleanup): boolean {
  return (
    !r.clipBox &&
    r.height?.min === undefined &&
    r.height?.max === undefined &&
    r.hiddenClasses.length === 0 &&
    r.regions.length === 0 &&
    !r.noise
  );
}

/** What a save or an export removes (the Apply cleanup line of the export dialog). */
export function cleanupRemoves(r: PointcloudCleanup): {
  box: 'inside' | 'outside' | null;
  height: boolean;
  deletes: number;
  hiddenClasses: number[];
} {
  return {
    // keep inside removes what is outside, and the other way round
    box: r.clipBox ? (r.clipBox.keep === 'inside' ? 'outside' : 'inside') : null,
    height: r.height?.min !== undefined || r.height?.max !== undefined,
    deletes: r.regions.filter((g) => g.action.kind === 'delete').length,
    hiddenClasses: [...r.hiddenClasses].sort((a, b) => a - b),
  };
}

/** `pointcloud.clean` (python `aio_pipelines/pointcloud_cleanup/pipeline.py`). */
export const PointcloudCleanParams = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('noise'),
      layerId: Id,
      /** The layer's COPC file, project-relative (checked against the manifest). */
      src: ProjectPath,
      outlier: OutlierParams,
      elm: ElmParams.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('save'),
      layerId: Id,
      src: ProjectPath,
      recipe: PointcloudCleanup,
      /** The new layer is named "<name> (cleaned)". */
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
]);
export type PointcloudCleanParams = z.infer<typeof PointcloudCleanParams>;
