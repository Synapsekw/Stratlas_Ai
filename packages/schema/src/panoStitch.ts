import { z } from 'zod';
import { Id, IsoDate, IsoTime } from './common';

/*
 * Drone sphere panoramas (spec docs/plans/2026-10-13-drone-panoramas-design.md, plan
 * 2026-10-13-drone-panoramas-p1). One `panoramas` layer per import; each sphere is one `PanoRef`
 * whose files live in `panoramas/<layerId>/<panoId>/`: `frames/` (the source frames, never map
 * items), `pano.jpg`, `thumb.jpg` and the run record `stitch.json` (`aio.pano-stitch/1`).
 * Data-conventions section 34.
 */

export const PANO_STITCH_SCHEMA = 'aio.pano-stitch/1';
/** The first pipeline pack with `pano.stitch`, and how Settings, Processing tools names it. */
export const PANO_STITCH_MIN_PACK = '0.7.0';
export const PANO_STITCH_FEATURE = 'Stitching drone panoramas';
/** Largest `stitch.json` a reader opens. */
export const PANO_STITCH_MAX_BYTES = 256 * 1024;
/** Equirect width per quality; the height is half. */
export const PANO_WIDTH = { standard: 8192, high: 16384 } as const;
/** WebGL `MAX_TEXTURE_SIZE` that High needs; below it the option is hidden. */
export const PANO_HIGH_MIN_TEXTURE = 16384;

/** Folder-safe id of a pano layer or sphere (`panos-2026-09-10`, `p03`). */
export const PanoFolderId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'A panorama id is lower-case letters, digits and dashes');

export const PanoQuality = z.enum(['standard', 'high']);
export type PanoQuality = z.infer<typeof PanoQuality>;

export const PanoStitchStatus = z.enum(['queued', 'running', 'done', 'failed']);
export type PanoStitchStatus = z.infer<typeof PanoStitchStatus>;

/** `PanoRef.stitch`. `run` (the job id) is absent until a job was started. */
export const PanoStitchState = z
  .object({
    run: Id.optional(),
    status: PanoStitchStatus,
    error: z.string().max(400).optional(),
  })
  .strict();
export type PanoStitchState = z.infer<typeof PanoStitchState>;

/**
 * `PanoRef.cov`: the part of the sphere the image shows. `top` and `bottom`: degrees above and
 * below the horizon at the image's top and bottom edge. `left` and `right` (both or neither): the
 * yaw range of a wide panorama, degrees clockwise from north, `left < right <= left + 360`.
 */
export const PanoCov = z
  .object({
    top: z.number().min(-90).max(90),
    bottom: z.number().min(-90).max(90),
    left: z.number().min(-360).max(360).optional(),
    right: z.number().min(-360).max(720).optional(),
  })
  .strict()
  .refine((c) => (c.left === undefined) === (c.right === undefined), {
    message: 'A yaw range has both ends.',
  })
  .refine(
    (c) =>
      c.left === undefined ||
      c.right === undefined ||
      (c.right > c.left && c.right - c.left <= 360),
    { message: 'A yaw range runs clockwise and spans at most 360 degrees.' },
  );
export type PanoCov = z.infer<typeof PanoCov>;

export const PanoShape = z.enum(['sphere', 'wide']);
export type PanoShape = z.infer<typeof PanoShape>;

const FrameName = z
  .string()
  .min(1)
  .max(260)
  .regex(/^[^/\\]+$/, 'A frame is named by its file name');

export const PanoStitchFile = z.object({
  schema: z.literal(PANO_STITCH_SCHEMA),
  /** The job that wrote it. */
  run: Id,
  layer: PanoFolderId,
  pano: PanoFolderId,
  createdAt: IsoTime,
  engine: z.object({ version: z.string().min(1).max(40), opencv: z.string().max(40).optional() }),
  quality: PanoQuality,
  shape: PanoShape,
  size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  frames: z.object({
    used: z.array(FrameName).max(200),
    dropped: z.array(z.object({ file: FrameName, reason: z.string().min(1).max(200) })).max(200),
  }),
  aligned: z.enum(['features', 'metadata']),
  /** Median feature residual after the adjustment, pixels at the 1600 px working width. */
  residualPx: z.number().nonnegative().nullable(),
  /** Largest turn of a matched frame away from its gimbal seed, degrees. */
  maxDriftDeg: z.number().nonnegative().nullable(),
  /** The shared focal length the adjustment settled on, over the EXIF one (1 without features). */
  focalScale: z.number().positive(),
  /** What real pixels cover; a sphere's sky above `topDeg` is a gradient fill. */
  coverage: z.object({
    topDeg: z.number().min(-90).max(90),
    bottomDeg: z.number().min(-90).max(90),
    leftDeg: z.number().min(-360).max(360).optional(),
    rightDeg: z.number().min(-360).max(720).optional(),
  }),
  /** Seconds per step (`read`, `seed`, `match`, `adjust`, `compose`, `fill`, `write`). */
  timings: z.record(z.string(), z.number().nonnegative()),
  warnings: z.array(z.string().max(400)).max(50),
});
export type PanoStitchFile = z.infer<typeof PanoStitchFile>;

/** The folder of one sphere, project-relative. */
export function panoFolder(layer: string, pano: string): string {
  return `panoramas/${layer}/${pano}`;
}

// ------------------------------------------------------------------ scan (panos:scan)

/** Why a file of a scanned folder is not part of a panorama. */
export const PanoSkipReason = z.enum([
  'unreadable',
  'no-position',
  'no-gimbal',
  'few-frames',
  'narrow-yaw',
  'one-pitch-row',
  'different-size',
]);
export type PanoSkipReason = z.infer<typeof PanoSkipReason>;

const Thumb = z.string().max(200_000).startsWith('data:image/jpeg;base64,');

export const PanoScanSphere = z.object({
  /** `s1`, `s2` ... in capture order; the import names spheres by it. */
  key: z.string().min(1).max(40),
  shape: PanoShape,
  /** Its frames, absolute, in capture order (Add data leaves them out of a photo import). */
  files: z.array(z.string().min(1).max(2048)).min(1).max(500),
  frames: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  /** Local capture time of the first frame, `YYYY-MM-DDTHH:mm:ss`. */
  startedAt: z.string().max(40),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  absAlt: z.number().optional(),
  /** Height above the take-off point (the preview's "height above ground"). */
  relAlt: z.number().optional(),
  /** Fewer frames than its siblings. */
  incomplete: z.boolean(),
  /** The layer that holds these frames already (the row starts unchecked). */
  alreadyIn: z.string().max(200).optional(),
  thumb: Thumb.optional(),
});
export type PanoScanSphere = z.infer<typeof PanoScanSphere>;

/** A ready-made equirect (2:1 or `GPano`), imported as it is. */
export const PanoScanReady = z.object({
  key: z.string().min(1).max(40),
  file: z.string().min(1).max(2048),
  bytes: z.number().int().nonnegative(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  absAlt: z.number().optional(),
  relAlt: z.number().optional(),
  takenAt: z.string().max(40).optional(),
  thumb: Thumb.optional(),
});
export type PanoScanReady = z.infer<typeof PanoScanReady>;

export const PanoScanSkipped = z.object({
  file: z.string().min(1).max(2048),
  reason: PanoSkipReason,
});
export type PanoScanSkipped = z.infer<typeof PanoScanSkipped>;

export const PanoScan = z.object({
  scanId: z.string().min(1).max(64),
  spheres: z.array(PanoScanSphere).max(500),
  ready: z.array(PanoScanReady).max(500),
  skipped: z.array(PanoScanSkipped).max(20_000),
  /** JPEG files looked at. */
  files: z.number().int().nonnegative(),
  /** The day most sphere frames carry, for the survey date and the layer name. */
  day: IsoDate.nullable(),
});
export type PanoScan = z.infer<typeof PanoScan>;
