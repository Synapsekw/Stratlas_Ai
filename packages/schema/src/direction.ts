import { z } from 'zod';
import { Vec3 } from './common';

/*
 * Hand-set camera directions (video direction keyframes, phase 1) and photo corrections ("Align
 * camera to map", "Align photo to map"). Kept apart from layers.ts: the video layer and PhotoRef
 * only gain one optional field each that uses these.
 */

/**
 * How the camera turns between a direction keyframe and the next one (and, on the first and last
 * keyframe, before and after them):
 * - `smooth`: shortest-arc turn from this keyframe's direction to the next one's;
 * - `track`: keep this keyframe's heading offset from the flight track (the offset eases to the
 *   next keyframe's), pitch and roll eased;
 * - `lookAt`: aim at `target` from where the drone is (orbits, point-of-interest shots), blending
 *   in and out over half a second at the keyframes.
 */
export const DIRECTION_FILLS = ['smooth', 'track', 'lookAt'] as const;
export const DirectionFill = z.enum(DIRECTION_FILLS);

/**
 * One camera direction keyframe of a video clip (set by hand where the flight log has no gimbal
 * angles). `t` is clip time (milliseconds of video, so the keyframe stays on its frame when the
 * time offset changes); `yaw` is the heading clockwise from grid north, `pitch` is up positive
 * (negative looks down), `roll` drops the image's right side, all degrees in the project grid
 * frame (as `cameraQuatFromGimbal`). Keyframes are absolute: they replace the logged orientation
 * and its calibration bias. `fill` is kept as text so a later build's fill (Phase 2 "measured")
 * still reads here; a fill this build does not know turns smoothly.
 */
export const DirectionKey = z
  .object({
    t: z.number().nonnegative(),
    yaw: z.number().min(-360).max(360),
    pitch: z.number().min(-90).max(90),
    roll: z.number().min(-180).max(180),
    fill: z.string().min(1).max(32),
    /** What a `lookAt` keyframe aims at, local frame (x east, y up, z south), metres. */
    target: Vec3.optional(),
  })
  .refine((k) => k.fill !== 'lookAt' || k.target !== undefined, {
    message: 'A look-at keyframe needs a target',
    path: ['target'],
  });

/** A clip's direction keyframes, in time order (at most one per millisecond). */
export const DirectionKeys = z
  .array(DirectionKey)
  .max(1000)
  .refine((ks) => ks.every((k, i) => i === 0 || k.t > (ks[i - 1]?.t ?? -1)), {
    message: 'Direction keyframes must be in time order, one per time',
  });

/**
 * A hand correction of a photo's camera ("Align photo to map") against the pose it was imported
 * with (`pos` and `q` from GPS and the EXIF/XMP gimbal angles): degrees added to its heading
 * (clockwise from grid north), pitch (up positive) and roll in the project grid frame, and metres
 * added to its position (local frame). The image, its EXIF and the imported pose stay unchanged.
 */
export const PhotoCorrection = z.object({
  yawDeg: z.number().min(-180).max(180),
  pitchDeg: z.number().min(-90).max(90),
  rollDeg: z.number().min(-180).max(180),
  offsetM: Vec3.optional(),
});

export type DirectionFill = z.infer<typeof DirectionFill>;
export type DirectionKey = z.infer<typeof DirectionKey>;
export type PhotoCorrection = z.infer<typeof PhotoCorrection>;
