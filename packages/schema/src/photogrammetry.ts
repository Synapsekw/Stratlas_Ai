import { z } from 'zod';
import { LonLatRing } from './change';
import { Id, IsoTime, ProjectPath, Vec3 } from './common';
import { Crs } from './manifest';

/**
 * Photogrammetry (M10, decisions of 7 Oct 2026): a folder of drone photos becomes the layers the
 * app already shows (ortho, DSM and DTM, COPC cloud, textured mesh) through pipeline jobs in the
 * pack (`photo.align`, `photo.georef`, `photo.products`). Nothing here is a layer kind: outputs are
 * ordinary `mesh`, `pointcloud` (`copc`) and `raster` (`kit-pyramid`) layers, and their provenance
 * lives beside the manifest in `<project>/photogrammetry/<run>/` (data-conventions section 21), a
 * folder older builds never read.
 *
 * New `/1` files keep keys a later 1.x build adds (`looseObject`) wherever this build writes them.
 */

/** A run id: file-name safe on Windows and macOS, the folder name under `photogrammetry/`. */
export const PhotoRunId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, 'A run id is letters, digits, dot, dash or _.');

/** Where a run's files live, relative to the project root. */
export const PHOTO_DIR = 'photogrammetry';
export const photoRunDir = (run: string): string => `${PHOTO_DIR}/${run}`;
/** Files of a run, relative to the run folder. `work/` is the only part that may be deleted. */
export const PHOTO_RUN_FILES = {
  run: 'run.json',
  gcp: 'gcp.json',
  accuracy: 'report/accuracy.json',
  align: 'report/align.json',
  products: 'report/products.json',
  sparse: 'sparse/',
  work: 'work/',
} as const;

/** Quality preset of the wizard (plan "Quality presets"). */
export const PhotoPreset = z.enum(['fast', 'standard', 'high']);
/** What `photo.products` makes. `tiles` hands the full mesh and cloud to `tiles.mesh`/`tiles.cloud`. */
export const PhotoProduct = z.enum(['cloud', 'dsm', 'dtm', 'ortho', 'mesh', 'tiles']);

/** The photos of a run: an existing photos layer, or folders read in place (never written). */
export const PhotoSource = z.union([
  z.object({ layer: Id }).strict(),
  z.object({ folders: z.array(z.string().min(1).max(1024)).min(1).max(100) }).strict(),
]);

/** Stages of the three jobs, in order (`photo.align`, `photo.georef`, `photo.products`). */
export const PhotoStageName = z.enum([
  'inspect',
  'features',
  'match',
  'sfm',
  'georef',
  'adjust',
  'report',
  'dense',
  'fuse',
  'cloud',
  'dsm',
  'dtm',
  'ortho',
  'mesh',
  'texture',
  'tiles',
  'commit',
]);

export const PhotoStage = z.looseObject({
  name: PhotoStageName,
  state: z.enum(['pending', 'running', 'done', 'skipped', 'failed', 'cancelled']),
  startedAt: IsoTime.optional(),
  finishedAt: IsoTime.optional(),
  seconds: z.number().nonnegative().optional(),
  /** Peak resident memory of the stage, bytes. */
  memoryPeakBytes: z.number().int().nonnegative().optional(),
  message: z.string().max(2000).optional(),
});

/** One calibration group: photos from one camera body and lens. */
export const PhotoCameraGroup = z.looseObject({
  id: Id,
  make: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  focalMm: z.number().positive().optional(),
  sensorWidthMm: z.number().positive().optional(),
  /** COLMAP camera model of the self-calibration, e.g. `OPENCV` or `FULL_OPENCV`. */
  calibration: z.string().max(40).optional(),
  photos: z.number().int().nonnegative(),
});

/**
 * Where the run's heights came from and how they were converted (the Al-Zour lesson: every run
 * states it). `geoid` names the PROJ grid used for ellipsoidal to orthometric conversions.
 */
export const PhotoHeights = z.looseObject({
  source: z.enum(['ellipsoidal', 'orthometric', 'relative', 'gcp']),
  geoid: z.enum(['egm96', 'egm2008', 'none']).optional(),
  /** The manifest's `verticalDatum.absAltOffsetM` when it was applied. */
  absAltOffsetM: z.number().optional(),
  note: z.string().max(300).optional(),
});

/** A photo left out, with the reason shown in the report ("motion blur", "duplicate of ..."). */
export const PhotoRejected = z.looseObject({
  name: z.string().min(1).max(260),
  reason: z.string().min(1).max(300),
});

/** RMSE in metres over the points of one role. */
export const Rmse = z.object({
  n: z.number().int().nonnegative(),
  horizontalM: z.number().nonnegative(),
  verticalM: z.number().nonnegative(),
});

/** The summary a run keeps of its last accuracy report (the full report is `aio.photo-accuracy/1`). */
export const AccuracySummary = z.looseObject({
  control: Rmse.optional(),
  check: Rmse.optional(),
  meanReprojPx: z.number().nonnegative(),
  gsdCm: z.number().positive().optional(),
  warnings: z.number().int().nonnegative().optional(),
});

/** What this computer can do (the `photo:probe` channel and the run's `hardware`). */
export const HardwareProbe = z.looseObject({
  platform: z.string().min(1).max(40),
  arch: z.string().min(1).max(40),
  cpu: z.object({
    model: z.string().max(200),
    cores: z.number().int().positive(),
    threads: z.number().int().positive().optional(),
  }),
  memoryBytes: z.number().int().nonnegative(),
  /** Free space on the drive of the data folder. */
  freeDiskBytes: z.number().int().nonnegative(),
  gpus: z
    .array(
      z.object({
        name: z.string().max(200),
        vendor: z.string().max(80).optional(),
        vramBytes: z.number().int().nonnegative().optional(),
      }),
    )
    .max(16),
  /** The pack's CUDA build is present and works (decision 5: M10.1 at the earliest). */
  cuda: z.boolean(),
  /**
   * Whether processing can run here: `available`, or why not (decision 8: Windows x64 and macOS
   * arm64 only; the pack must be 0.4.0 or later).
   */
  processing: z.enum(['available', 'unsupported-platform', 'pack-too-old', 'no-pack']),
});

/** The wizard's estimate before a run starts (`photo:estimate`). */
export const PhotoEstimate = z.object({
  /** A range: thermal throttling and scene content make one number dishonest. */
  minutes: z.tuple([z.number().nonnegative(), z.number().nonnegative()]),
  diskBytes: z.number().int().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
  /** Plain-words notes ("Standard on 16 GB: images at half size"). */
  notes: z.array(z.string().max(300)).max(20).optional(),
});

/**
 * `<project>/photogrammetry/<run>/run.json` (`aio.photo-run/1`): one processing run, written by the
 * pack's jobs (atomically, staging plus rename) and read by the app. It lists the layers, tilesets
 * and files the run made, so the manifest itself needs no new field.
 */
export const PhotoRun = z.looseObject({
  schema: z.literal('aio.photo-run/1'),
  id: PhotoRunId,
  createdAt: IsoTime,
  updatedAt: IsoTime.optional(),
  status: z.enum(['aligning', 'aligned', 'adjusted', 'processing', 'done', 'failed', 'cancelled']),
  preset: PhotoPreset,
  photos: z.looseObject({
    source: PhotoSource,
    count: z.number().int().nonnegative(),
    registered: z.number().int().nonnegative().optional(),
    rejected: z.array(PhotoRejected).max(100_000).optional(),
  }),
  cameras: z.array(PhotoCameraGroup).max(100),
  crs: Crs,
  heights: PhotoHeights.optional(),
  /** The job parameters as given (for **Re-run products** and the report). */
  settings: z.record(z.string(), z.unknown()).optional(),
  /** Optional processing limit (lon/lat). */
  region: LonLatRing.optional(),
  /** Survey date of the run's layers (a manifest capture id). */
  capture: Id.optional(),
  stages: z.array(PhotoStage).max(64),
  outputs: z.looseObject({
    layers: z.array(Id).max(64),
    tilesets: z.array(Id).max(64),
    files: z.array(ProjectPath).max(256),
  }),
  accuracy: AccuracySummary.optional(),
  /** Component versions: `pack`, `colmap`, `pdal`, `opencv` and so on. */
  versions: z.record(z.string().min(1).max(40), z.string().max(80)),
  hardware: HardwareProbe.optional(),
  warnings: z.array(z.string().max(500)).max(1000).optional(),
});

// ---------------------------------------------------------------- ground control

export const GcpRole = z.enum(['control', 'check']);
/** A mark is a draft until a person confirms it (detector or prediction), or skipped. */
export const GcpMarkState = z.enum(['draft', 'confirmed', 'skipped']);

/** Where a point is seen in one photo, in pixels of the original image (x right, y down). */
export const GcpMark = z.looseObject({
  /** Photo id of the photos layer, or the file name for a folder run. */
  photo: z.string().min(1).max(260),
  px: z.tuple([z.number(), z.number()]),
  by: z.enum(['person', 'detector', 'import']),
  at: IsoTime,
  state: GcpMarkState,
});

/** Where the current cameras say a point is, with a search radius from their uncertainty. */
export const GcpPrediction = z.looseObject({
  photo: z.string().min(1).max(260),
  px: z.tuple([z.number(), z.number()]),
  radiusPx: z.number().nonnegative(),
});

export const GcpPoint = z.looseObject({
  id: z.string().min(1).max(64),
  label: z.string().max(120).optional(),
  role: GcpRole,
  /** In the file's `crs`: easting, northing, height (or longitude, latitude, height). */
  xyz: Vec3,
  /** Stated accuracy, metres (1 sigma). */
  accuracy: z.object({ horizontalM: z.number().positive(), verticalM: z.number().positive() }),
  /** Left out of the adjustment and the report by a person (kept, never deleted). */
  disabled: z.boolean().optional(),
  marks: z.array(GcpMark).max(10_000),
  predicted: z.array(GcpPrediction).max(10_000).optional(),
});

/**
 * `<project>/photogrammetry/<run>/gcp.json` (`aio.gcp/1`): control and check points and their
 * marks. Written by the app (`photo:writeGcp`, atomic with a `.bak`) and by `photo.align`
 * (predictions only). Checkpoints are measured, never used in the adjustment.
 */
export const GcpFile = z
  .looseObject({
    schema: z.literal('aio.gcp/1'),
    crs: Crs,
    heights: PhotoHeights.optional(),
    /** Where the points came from (a file name, never a full path). */
    importedFrom: z.string().max(260).optional(),
    points: z.array(GcpPoint).max(1000),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const p of f.points) {
      if (seen.has(p.id))
        ctx.addIssue({ code: 'custom', message: `Duplicate point "${p.id}"`, path: ['points'] });
      seen.add(p.id);
    }
  });

/** One point of the accuracy report: residuals of the adjusted model against the surveyed point. */
export const AccuracyPoint = z.looseObject({
  id: z.string().min(1).max(64),
  role: GcpRole,
  dxM: z.number(),
  dyM: z.number(),
  dzM: z.number(),
  reprojPx: z.number().nonnegative(),
  marks: z.number().int().nonnegative(),
});

export const AccuracyWarning = z.looseObject({
  code: z.enum([
    'gcp-outlier',
    'few-marks',
    'gnss-height',
    'unregistered',
    'disconnected',
    'low-overlap',
    'other',
  ]),
  message: z.string().min(1).max(500),
  point: z.string().max(64).optional(),
});

/**
 * `<project>/photogrammetry/<run>/report/accuracy.json` (`aio.photo-accuracy/1`), written by
 * `photo.align` (GNSS only) and `photo.georef`. Honest by construction: every residual is listed
 * and `checkpointsInAdjustment` is always false.
 */
export const AccuracyReport = z.looseObject({
  schema: z.literal('aio.photo-accuracy/1'),
  run: PhotoRunId,
  createdAt: IsoTime,
  crs: Crs,
  heights: PhotoHeights.optional(),
  gsdCm: z.number().positive().optional(),
  images: z.object({
    total: z.number().int().nonnegative(),
    registered: z.number().int().nonnegative(),
  }),
  meanReprojPx: z.number().nonnegative(),
  points: z.array(AccuracyPoint).max(1000),
  rmse: z.object({ control: Rmse.optional(), check: Rmse.optional() }),
  /** Camera positions after adjustment against their GNSS positions. */
  cameraResiduals: z
    .object({
      medianM: z.number().nonnegative(),
      maxM: z.number().nonnegative(),
      rmseHorizontalM: z.number().nonnegative(),
      rmseVerticalM: z.number().nonnegative(),
    })
    .optional(),
  /** Images per ground point, as a single-band raster in the run folder. */
  overlap: ProjectPath.optional(),
  checkpointsInAdjustment: z.literal(false),
  warnings: z.array(AccuracyWarning).max(1000),
});

/** A run in the runs list (`photo:runs`). */
export const PhotoRunSummary = z.object({
  id: PhotoRunId,
  createdAt: IsoTime,
  status: PhotoRun.shape.status,
  preset: PhotoPreset,
  photos: z.number().int().nonnegative(),
  products: z.array(PhotoProduct),
  accuracy: AccuracySummary.optional(),
});

export type PhotoRunId = z.infer<typeof PhotoRunId>;
export type PhotoPreset = z.infer<typeof PhotoPreset>;
export type PhotoProduct = z.infer<typeof PhotoProduct>;
export type PhotoSource = z.infer<typeof PhotoSource>;
export type PhotoStageName = z.infer<typeof PhotoStageName>;
export type PhotoStage = z.infer<typeof PhotoStage>;
export type PhotoCameraGroup = z.infer<typeof PhotoCameraGroup>;
export type PhotoHeights = z.infer<typeof PhotoHeights>;
export type AccuracySummary = z.infer<typeof AccuracySummary>;
export type HardwareProbe = z.infer<typeof HardwareProbe>;
export type PhotoEstimate = z.infer<typeof PhotoEstimate>;
export type PhotoRun = z.infer<typeof PhotoRun>;
export type GcpRole = z.infer<typeof GcpRole>;
export type GcpMarkState = z.infer<typeof GcpMarkState>;
export type GcpMark = z.infer<typeof GcpMark>;
export type GcpPoint = z.infer<typeof GcpPoint>;
export type GcpFile = z.infer<typeof GcpFile>;
export type AccuracyReport = z.infer<typeof AccuracyReport>;
export type PhotoRunSummary = z.infer<typeof PhotoRunSummary>;
