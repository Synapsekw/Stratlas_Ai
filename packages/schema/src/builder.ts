import { z } from 'zod';
import { IsoDate, Mat4, Vec3 } from './common';
import { CameraOrientation, LensModel } from './layers';
import { ClassCatalogue, SeverityModel } from './severity';

/** What a project is for; picks defaults in the builder and the landing screen. */
export const ProjectType = z.enum(['inspection', 'volumetric', 'road', 'twin', 'fusion']);

/** A severity model (with its classes) offered by the new project wizard. */
export const SeverityTemplate = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Projects the model comes from, for the picker. */
  source: z.string(),
  model: SeverityModel,
  catalogue: ClassCatalogue.optional(),
});

/** Report brand the project uses (e&, Zain, white label). */
export const ReportBrand = z.object({ id: z.string().min(1), label: z.string().min(1) });

export const NewProjectRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    customer: z.string().trim().max(120).optional(),
    site: z.string().trim().max(200).optional(),
    type: ProjectType,
    /** Projected CRS (metres) of the project frame. */
    epsg: z.number().int(),
    /** Project origin in that CRS (E, N, H). */
    origin: Vec3,
    captureDate: IsoDate.optional(),
    /** Id of a SeverityTemplate, or null for the general template. */
    severityTemplate: z.string().min(1).nullable(),
    brand: z.string().min(1).optional(),
  })
  .strict();

export const ImportItem = z.object({
  /** File name as given. */
  file: z.string(),
  kind: z.enum(['photo', 'video', 'telemetry', 'mesh', 'raster', 'pointcloud', 'unknown']),
  /**
   * `needs-pipeline`: the conversion runs in the pipeline pack (LAS/LAZ/E57 to COPC, large
   * GeoTIFF tiling), which is not installed; `queued`: handed to the pipeline pack as a job.
   */
  status: z.enum(['imported', 'skipped', 'needs-pipeline', 'queued', 'error']),
  message: z.string().optional(),
  layerId: z.string().optional(),
  jobId: z.string().optional(),
});

/**
 * Patch for `builder:updateLayers`: a mesh georeference, or a video calibration (time offset,
 * lens, orientation bias, position offset; `null` clears a bias).
 */
export const LayerPatch = z.union([
  z.object({ transform: Mat4 }).strict(),
  z
    .object({
      offsetMs: z.number().optional(),
      lens: LensModel.optional(),
      orientation: CameraOrientation.nullable().optional(),
      positionOffsetM: Vec3.nullable().optional(),
    })
    .strict()
    .refine(
      (p) =>
        p.offsetMs !== undefined ||
        p.lens !== undefined ||
        p.orientation !== undefined ||
        p.positionOffsetM !== undefined,
      { message: 'Give offsetMs, lens, orientation or positionOffsetM' },
    ),
]);

export type ProjectType = z.infer<typeof ProjectType>;
export type SeverityTemplate = z.infer<typeof SeverityTemplate>;
export type ReportBrand = z.infer<typeof ReportBrand>;
export type NewProjectRequest = z.infer<typeof NewProjectRequest>;
export type ImportItem = z.infer<typeof ImportItem>;
export type LayerPatch = z.infer<typeof LayerPatch>;
