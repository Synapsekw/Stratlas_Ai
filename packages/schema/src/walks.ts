import { z } from 'zod';
import { AssetRef, Id, IsoTime, Quat, Vec3 } from './common';

/*
 * `walks/<id>/walk.json` (`aio.walk/1`, PROPOSAL pending founder review): one 360 video brought
 * into a project from a 360 camera's own file or from a stitched equirectangular MP4. It lives in
 * a side folder with its playback copy and poster, not in the manifest, so builds that do not
 * know it never read it and open the project as before (data-conventions section 32). The front
 * slice of Walks 360 part W1; the later parts add pose, stills and motion data beside it.
 */

export const WALK_SCHEMA = 'aio.walk/1';

/** The folder of a project that holds its walks, one sub-folder per walk. */
export const WALKS_DIR = 'walks';

/**
 * How the source file held the picture:
 * - `insv-dual-stream`: an Insta360 `.insv` with one video track per lens (X4 verified);
 * - `dual-fisheye`: both fisheye pictures side by side in one frame (the `.lrv` proxy);
 * - `equirect`: already stitched (2:1 equirectangular), stored without a stitch.
 */
export const WALK_LAYOUTS = ['insv-dual-stream', 'dual-fisheye', 'equirect'] as const;
export const WalkLayout = z.enum(WALK_LAYOUTS);
export type WalkLayout = z.infer<typeof WalkLayout>;

/** A path inside the project folder, forward slashes, no parent segments. */
const WalkPath = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !/^[/\\]|^[a-z]:|(^|[/\\])\.\.([/\\]|$)|\\/i.test(p), {
    message: 'A walk file path stays inside the project folder',
  });

/** One video track of the source file. */
export const WalkStream = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Sample entry fourcc (`hvc1`, `avc1`, ...). */
  codec: z.string().min(1).max(16),
  fps: z.number().nonnegative(),
});

export const WalkSource = z.object({
  /** File name only: the original stays where it is and its folder is not recorded. */
  file: z.string().min(1).max(260),
  bytes: z.number().int().nonnegative().optional(),
  layout: WalkLayout,
  /** The file ended with the Insta360 trailer mark. */
  trailer: z.boolean().optional(),
  /** The camera's local time from the file name (`VID_20260101_120000_...`), no zone. */
  capturedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    .optional(),
  /** The source's video tracks (two for `insv-dual-stream`, else one). */
  streams: z.array(WalkStream).min(1).max(4),
  /** A low resolution proxy was imported because the full clip was not given. */
  lowRes: z.boolean().optional(),
});

/** The playback copy: equirectangular, a codec Chromium plays. */
export const WalkVideo = z.object({
  src: WalkPath,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationS: z.number().nonnegative(),
  fps: z.number().nonnegative(),
  audio: z.boolean(),
});

/** How the playback copy was stitched (absent for `equirect` sources). */
export const WalkStitch = z.object({
  tool: z.string().min(1).max(64),
  /** The projection filter as it was given to the tool. */
  filter: z.string().min(1).max(400),
  /** Field of view assumed for each lens, degrees. */
  fovDeg: z.number().positive().max(360),
  encoder: z.string().min(1).max(32),
});

export const WalkFile = z.object({
  schema: z.literal(WALK_SCHEMA),
  /** The walk's folder name under `walks/`. */
  id: Id.regex(/^[a-z0-9][a-z0-9-]*$/, 'A walk id is lower-case letters, digits and dashes'),
  name: z.string().min(1).max(200),
  createdAt: IsoTime,
  source: WalkSource,
  video: WalkVideo,
  poster: WalkPath.optional(),
  stitch: WalkStitch.optional(),
});
export type WalkFile = z.infer<typeof WalkFile>;
export type WalkSource = z.infer<typeof WalkSource>;
export type WalkStream = z.infer<typeof WalkStream>;
export type WalkVideo = z.infer<typeof WalkVideo>;
export type WalkStitch = z.infer<typeof WalkStitch>;

// ---- Walk layer and placing (founder, 12 Oct 2026; data-conventions section 32) ----

/** `walks/<id>/raw-path.json`: the walk's path in the pipeline's own (raw) frame. */
export const WALK_PATH_SCHEMA = 'aio.walkpath/1';
/** `walks/<id>/orientation.json`: the header of the camera orientation records. */
export const WALK_ORIENT_SCHEMA = 'aio.walkorient/1';
/** A pin's surface when it was set on the 3D model rather than on a drawing. */
export const MODEL_SURFACE = '@model';
/** Camera height above the ground of a walk, metres, unless the calibration says otherwise. */
export const WALK_HEIGHT_M = 1.7;
/** Most pins one walk carries. */
export const MAX_WALK_PINS = 64;

/**
 * One pin: at playback time `t` (seconds) the camera stood over `at`. On a drawing (`surface` is
 * the drawing's raster layer id) `at` is the plan picture's pixel `[x, y]`; on the model
 * (`@model`) it is the model frame's `[x, z]` with the ground height `y` where the pin was set.
 */
export const WalkPin = z
  .object({
    t: z.number().nonnegative(),
    surface: z.union([z.literal(MODEL_SURFACE), Id]),
    at: z.tuple([z.number(), z.number()]),
    y: z.number().optional(),
  })
  .strict();

/** How well the path fits its pins: residual under 0.5 m good, under 2 m check, else poor. */
export const WalkQuality = z.enum(['good', 'check', 'poor', 'unplaced']);

/** The placement of a walk on the project: its pins and the hand corrections. */
export const WalkCalibration = z
  .object({
    pins: z.array(WalkPin).max(MAX_WALK_PINS),
    /** Turn of the view about up against the fit, degrees. */
    yawOffsetDeg: z.number().min(-180).max(180),
    heightM: z.number().min(0).max(10).default(WALK_HEIGHT_M),
    quality: WalkQuality,
    /** Free text: what the walk was placed on (shown in the tree). */
    placedOn: z.string().min(1).max(128).optional(),
  })
  .strict();

/**
 * One still the pipeline took from the video: frame `n` at playback time `t`. `pos` and `q` (raw
 * frame, three.js camera axes) are absent when the still was not registered; `segment` tells the
 * separate reconstructions apart (their raw frames differ); `steps` counts steps walked so far.
 */
export const WalkStill = z.object({
  n: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  pos: Vec3.optional(),
  q: Quat.optional(),
  segment: z.number().int().nonnegative().optional(),
  steps: z.number().nonnegative(),
});

/** `raw-path.json` (`aio.walkpath/1`), written by `walk.process`. */
export const WalkRawPath = z.object({
  schema: z.literal(WALK_PATH_SCHEMA),
  /** The walk id (its folder under `walks/`). */
  walk: z.string().min(1),
  /** `sfm`: positions from a reconstruction; `pins-only`: none, the pins carry the path. */
  source: z.enum(['sfm', 'pins-only']),
  /** The raw frame's up direction. */
  up: Vec3.optional(),
  stills: z.array(WalkStill).min(1).max(100_000),
  /** The part of the video where the camera walked (not standing still). */
  walking: z.object({ startT: z.number(), endT: z.number() }).optional(),
  /** Still numbers (`n`) kept on disk under `stills/`. */
  kept: z.array(z.number().int().nonnegative()).optional(),
});

/** Five little-endian float32 per record: `[t, qx, qy, qz, qw]`. */
export const WALK_ORIENT_LAYOUT = 'f32le-t-xyzw';
export const WALK_ORIENT_RECORD_BYTES = 20;

/**
 * `orientation.json` (`aio.walkorient/1`), written by `walk.process`: the header of the camera
 * orientation records in the file `data` beside it (`orientation.bin`). `t` of a record is seconds
 * after `startOffsetS`; quaternions are in the raw frame, three.js camera axes, x y z w order.
 */
export const WalkOrientation = z.object({
  schema: z.literal(WALK_ORIENT_SCHEMA),
  rateHz: z.number().min(1).max(2000),
  count: z.number().int().nonnegative().max(50_000_000),
  convention: z.literal('xyzw-camera-threejs'),
  frame: z.literal('raw'),
  startOffsetS: z.number(),
  /** A file name in the walk's folder, no path. */
  data: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .refine((n) => n !== '.' && n !== '..', { message: 'A data file name, not a folder' }),
  layout: z.literal(WALK_ORIENT_LAYOUT),
});

/**
 * The records of an orientation data file as `[t, qx, qy, qz, qw]` rows, `t` in playback seconds
 * (`startOffsetS` added). Null when the length is not `count * 20` (the file is refused as a
 * whole). A record with a value that is not finite, or a zero quaternion, is dropped; the others
 * are normalised.
 */
export function readWalkOrientationData(
  header: WalkOrientation,
  bytes: Uint8Array,
): Float64Array[] | null {
  if (bytes.byteLength !== header.count * WALK_ORIENT_RECORD_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: Float64Array[] = [];
  for (let i = 0; i < header.count; i++) {
    const o = i * WALK_ORIENT_RECORD_BYTES;
    const t = view.getFloat32(o, true);
    const x = view.getFloat32(o + 4, true);
    const y = view.getFloat32(o + 8, true);
    const z = view.getFloat32(o + 12, true);
    const w = view.getFloat32(o + 16, true);
    const len = Math.hypot(x, y, z, w);
    if (!Number.isFinite(t) || !Number.isFinite(len) || len === 0) continue;
    rows.push(Float64Array.of(header.startOffsetS + t, x / len, y / len, z / len, w / len));
  }
  return rows;
}

/** The files `walk.process` wrote for a walk, as the layer refers to them. */
export const WalkPathRefs = z
  .object({
    raw: AssetRef,
    orientation: AssetRef.optional(),
    orientationData: AssetRef.optional(),
    points: AssetRef.optional(),
  })
  .strict();

export type WalkPin = z.infer<typeof WalkPin>;
export type WalkQuality = z.infer<typeof WalkQuality>;
export type WalkCalibration = z.infer<typeof WalkCalibration>;
export type WalkStill = z.infer<typeof WalkStill>;
export type WalkRawPath = z.infer<typeof WalkRawPath>;
export type WalkOrientation = z.infer<typeof WalkOrientation>;
export type WalkPathRefs = z.infer<typeof WalkPathRefs>;
