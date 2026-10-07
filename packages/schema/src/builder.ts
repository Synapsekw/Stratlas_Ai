import { z } from 'zod';
import { Id, IsoDate, Mat4, Vec3 } from './common';
import { CameraOrientation, DirectionKeys, LensModel } from './layers';
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

/**
 * How the absolute altitude a drone logs relates to the project height H (data-conventions
 * section 3a): `H = absolute altitude + absAltOffsetM`. DJI absolute altitude is barometric, offset
 * to GNSS at power-on (nominally above mean sea level, often tens of metres off), or ellipsoidal on
 * RTK aircraft; the offset is the geoid or site datum correction that makes it a project height
 * (minus the geoid undulation for ellipsoidal heights in an orthometric CRS; +100 at Al-Zour, whose
 * plant datum puts grade at EL 100). A project without one has no trusted absolute altitude.
 */
export const VerticalDatum = z
  .object({
    absAltOffsetM: z.number().min(-2000).max(2000),
    /** What the offset stands for, shown in the import summary. */
    note: z.string().max(300).optional(),
  })
  .strict();

/** Which drone altitude a camera height came from (`none`: the log had no altitude). */
export const AltitudeSource = z.enum(['absolute', 'relative', 'none']);

/**
 * Optional `heights` record of an `aio.flight/1` file: the altitude its sample heights came from
 * (`mixed`: some samples fell back to the other one) and the rule's numbers, `H = absolute +
 * absOffsetM` or `H = takeoffH + relative`. A file without it predates the record.
 */
export const FlightHeights = z.object({
  source: z.enum(['absolute', 'relative', 'none', 'mixed']),
  absOffsetM: z.number(),
  takeoffH: z.number(),
});

/**
 * The height rule for one raw import (`builder:import`). `auto`: absolute altitude with the
 * project's vertical datum when it defines one, else relative altitude plus the take-off height.
 * Files without the preferred altitude fall back to the other one.
 */
export const AltitudeChoice = z
  .object({
    source: z.enum(['auto', 'absolute', 'relative']),
    /** Project height H of the take-off point, for relative altitude; default the origin height. */
    takeoffH: z.number().min(-1000).max(10000).optional(),
    /**
     * Where `takeoffH` came from: the model or terrain under the take-off point, typed, or the
     * origin height the import UI proposed when there was no model there (summary warns).
     */
    takeoffFrom: z.enum(['terrain', 'typed', 'origin']).optional(),
    /**
     * For absolute altitude: the datum offset (`H = absolute + absAltOffsetM`); the import saves it
     * as the project's `verticalDatum`. Default the project's own.
     */
    absAltOffsetM: z.number().min(-2000).max(2000).optional(),
  })
  .strict();

/** The height rule an import applied, shown in its summary so the person can correct it. */
export const ImportHeights = z.object({
  /** The altitude the rule prefers; a file without it uses the other (its item says so). */
  source: z.enum(['absolute', 'relative']),
  /** Absolute: the datum offset added to the altitude. Relative: H of the take-off point. */
  offsetM: z.number(),
  /**
   * Absolute: `datum` (the project's vertical datum) or `uncorrected` (none, offset 0: heights may
   * be off by tens of metres). Relative: `terrain` (model under the take-off point), `typed`, or
   * `origin` (nothing confirmed: the take-off point is assumed at the project origin height).
   */
  from: z.enum(['datum', 'uncorrected', 'terrain', 'typed', 'origin']),
  note: z.string().optional(),
});

/** What the files of an import carry, so the import UI can propose a height rule. */
export const AltitudePlan = z.object({
  /** Files whose cameras get a height (photos with GPS, videos with their SRT). */
  files: z.number().int().nonnegative(),
  /** Of them, files with an absolute altitude (every frame) and with a relative altitude. */
  absolute: z.number().int().nonnegative(),
  relative: z.number().int().nonnegative(),
  datum: VerticalDatum.nullable(),
  /** What `auto` picks for these files in this project. */
  recommended: z.enum(['absolute', 'relative']),
  /**
   * The lowest logged camera position (local x, z) and its relative altitude: the take-off point
   * when `relAltM` is about 0, else the nearest the logs come to it.
   */
  takeoff: z.object({ x: z.number(), z: z.number(), relAltM: z.number() }).nullable(),
  /** Median of absolute minus relative altitude: the take-off point's absolute altitude. */
  takeoffAbsAlt: z.number().nullable(),
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
    /** Vertical datum of drone absolute altitudes (origin taken from a photo: offset 0). */
    verticalDatum: VerticalDatum.optional(),
  })
  .strict();

export const ImportItem = z.object({
  /** File name as given. */
  file: z.string(),
  /** `drawing` (M8): a DXF plot plan, imported by the `drawing.import` pipeline. */
  kind: z.enum([
    'photo',
    'video',
    'telemetry',
    'mesh',
    'raster',
    'pointcloud',
    'unknown',
    'drawing',
  ]),
  /**
   * `needs-pipeline`: the conversion runs in the pipeline pack (LAS/LAZ/E57 to COPC, large
   * GeoTIFF tiling), which is not installed; `queued`: handed to the pipeline pack as a job.
   */
  status: z.enum(['imported', 'skipped', 'needs-pipeline', 'queued', 'error']),
  message: z.string().optional(),
  layerId: z.string().optional(),
  jobId: z.string().optional(),
  /** Altitude the camera heights came from (`mixed`: some frames fell back to the other one). */
  heightSource: z.enum(['absolute', 'relative', 'none', 'mixed']).optional(),
});

/**
 * Patch for `builder:updateLayers`: a mesh georeference, or a video calibration (time offset,
 * lens, orientation bias, position offset, camera direction keyframes; `null` clears a bias or
 * the keyframes).
 */
export const LayerPatch = z.union([
  z.object({ transform: Mat4 }).strict(),
  z
    .object({
      offsetMs: z.number().optional(),
      lens: LensModel.optional(),
      orientation: CameraOrientation.nullable().optional(),
      positionOffsetM: Vec3.nullable().optional(),
      directionKeys: DirectionKeys.nullable().optional(),
    })
    .strict()
    .refine(
      (p) =>
        p.offsetMs !== undefined ||
        p.lens !== undefined ||
        p.orientation !== undefined ||
        p.positionOffsetM !== undefined ||
        p.directionKeys !== undefined,
      { message: 'Give offsetMs, lens, orientation, positionOffsetM or directionKeys' },
    ),
  /** The capture (survey date) of any layer kind (M8); `null` clears it. */
  z.object({ capture: Id.nullable() }).strict(),
]);

export type ProjectType = z.infer<typeof ProjectType>;
export type SeverityTemplate = z.infer<typeof SeverityTemplate>;
export type ReportBrand = z.infer<typeof ReportBrand>;
export type NewProjectRequest = z.infer<typeof NewProjectRequest>;
export type ImportItem = z.infer<typeof ImportItem>;
export type LayerPatch = z.infer<typeof LayerPatch>;
export type VerticalDatum = z.infer<typeof VerticalDatum>;
export type AltitudeSource = z.infer<typeof AltitudeSource>;
export type FlightHeights = z.infer<typeof FlightHeights>;
export type AltitudeChoice = z.infer<typeof AltitudeChoice>;
export type ImportHeights = z.infer<typeof ImportHeights>;
export type AltitudePlan = z.infer<typeof AltitudePlan>;
