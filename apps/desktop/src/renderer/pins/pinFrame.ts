import { shiftLocal, unshiftLocal, type ProjectManifest, type Vec3 } from '@aio/schema';
import { dateShiftOf } from '@aio/workspace';

/*
 * The date frame of pinned media: a pin is stored in its media layer's frame, so it drops where
 * it was clicked and moves with its own date when that date is lined up later. Readers add the
 * layer's date shift (`toDraw`), writers take it off (`toStore`); a layer of no date, or of a
 * date that is not lined up, never moves.
 */

type PinFrame = (p: Vec3, m: ProjectManifest, mediaLayerId: string) => Vec3;

/** A drawn point (as picked on the map or in 3D) in the stored frame of `mediaLayerId`. */
export const toStore: PinFrame = (p, m, mediaLayerId) =>
  unshiftLocal([p[0], p[1], p[2]], dateShiftOf(m, mediaLayerId));

/** A stored point of `mediaLayerId` where it draws. */
export const toDraw: PinFrame = (p, m, mediaLayerId) =>
  shiftLocal([p[0], p[1], p[2]], dateShiftOf(m, mediaLayerId));
