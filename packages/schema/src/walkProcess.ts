import { z } from 'zod';
import { IsoTime } from './common';
import { WalkLayout } from './walks';

/*
 * `walks/<id>/process.json` (`aio.walk-process/1`): the run record of the `walk.process` pipeline
 * (python `aio_pipelines/walk/`), written last, after every file it names is in place. The raw
 * path (`raw-path.json`) and the orientation (`orientation.json` + `orientation.bin`) belong to
 * the walk layer's schemas (`walks.ts`); this record only names them. `imu.bin`, `sparse.ply`,
 * `stills/` and `stabilized.mp4` are described here (data-conventions section 32).
 */

export const WALK_PROCESS_SCHEMA = 'aio.walk-process/1';

/** `imu.bin`: float32 little endian rows, these columns, at this rate (decimated motion data). */
export const WALK_IMU_COLUMNS = ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'] as const;
export const WALK_IMU_RATE_HZ = 200;

/** Largest `process.json` a reader opens. */
export const WALK_PROCESS_MAX_BYTES = 256 * 1024;

/** A path inside the project folder, forward slashes, no parent segments. */
const ProcessPath = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !/^[/\\]|^[a-z]:|(^|[/\\])\.\.([/\\]|$)|\\/i.test(p), {
    message: 'A walk file path stays inside the project folder',
  });

/** One lens of the calibration used for the stitch, in pixels of its lens stream. */
export const WalkProcessLens = z.object({
  cx: z.number(),
  cy: z.number(),
  radius: z.number().positive(),
  fovDeg: z.number().positive().max(360),
  yawDeg: z.number(),
  pitchDeg: z.number(),
  rollDeg: z.number(),
});

export const WalkPathSource = z.enum(['sfm', 'pins-only']);

export const WalkProcessFile = z.object({
  schema: z.literal(WALK_PROCESS_SCHEMA),
  /** The walk's folder name under `walks/`. */
  walk: z.string().min(1).max(80),
  createdAt: IsoTime,
  engine: z.object({
    version: z.string().min(1).max(40),
    pycolmap: z.string().max(40).optional(),
    ffmpeg: z.string().max(80).optional(),
  }),
  input: z.object({
    /** File name of the original (never its folder); absent when processed from the playback copy. */
    file: z.string().min(1).max(260).optional(),
    layout: WalkLayout,
    /** Where the lens model came from: the camera's trailer, the 195 degree default, or none (stitched input). */
    calibration: z.enum(['trailer', 'default', 'none']),
    lenses: z.array(WalkProcessLens).max(2).optional(),
    /** Motion data (gyro and accelerometer) was read. */
    imu: z.boolean(),
    camera: z.string().max(80).optional(),
  }),
  /** Project-relative paths of what the run wrote; each absent when not written. */
  outputs: z.object({
    rawPath: ProcessPath.optional(),
    orientation: ProcessPath.optional(),
    imu: ProcessPath.optional(),
    sparse: ProcessPath.optional(),
    stills: ProcessPath.optional(),
    stabilized: ProcessPath.optional(),
  }),
  stabilize: z.object({
    /** A levelled copy was written (pitch and roll removed). */
    levelled: z.boolean(),
    /** Yaw follows the walker (decision 3); the world-locked view rotates in the player. */
    keptYaw: z.literal(true),
  }),
  stills: z.object({
    sfm: z.number().int().nonnegative(),
    map: z.number().int().nonnegative(),
  }),
  path: z.object({
    source: WalkPathSource,
    registeredFraction: z.number().min(0).max(1),
    segments: z.number().int().nonnegative(),
  }),
  /** Seconds per stage (`read`, `frames`, `sfm`, `finish`, ...). */
  timings: z.record(z.string(), z.number().nonnegative()),
  warnings: z.array(z.string().max(400)).max(50),
});
export type WalkProcessFile = z.infer<typeof WalkProcessFile>;
export type WalkProcessLens = z.infer<typeof WalkProcessLens>;

/** What `walks:list` tells the app about a processed walk. */
export const WalkProcessSummary = z.object({
  createdAt: IsoTime,
  /** The levelled playback copy, project-relative, when one was written. */
  stabilized: ProcessPath.optional(),
  source: WalkPathSource,
  warnings: z.number().int().nonnegative(),
});
export type WalkProcessSummary = z.infer<typeof WalkProcessSummary>;

/** The summary of a run record. */
export function walkProcessSummary(f: WalkProcessFile): WalkProcessSummary {
  return {
    createdAt: f.createdAt,
    ...(f.outputs.stabilized ? { stabilized: f.outputs.stabilized } : {}),
    source: f.path.source,
    warnings: f.warnings.length,
  };
}
