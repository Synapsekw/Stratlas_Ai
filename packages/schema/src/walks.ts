import { z } from 'zod';
import { Id, IsoTime } from './common';

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
