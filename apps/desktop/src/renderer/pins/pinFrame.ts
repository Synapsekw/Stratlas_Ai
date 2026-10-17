import type { ProjectManifest, Vec3 } from '@aio/schema';

/*
 * The date frame of pinned media: a pin is stored in its media layer's frame, so it drops where
 * it was clicked and moves with its own date when that date is lined up later. `toStore` takes a
 * drawn (picked) point to the stored frame, `toDraw` the other way. Both are the identity until
 * the date line-up lands: Task 16 of the pinned media plan replaces them with `unshiftLocal` /
 * `shiftLocal` by `dateShiftOf(manifest, mediaLayerId)`.
 */

type PinFrame = (p: Vec3, m: ProjectManifest, mediaLayerId: string) => Vec3;

/** A drawn point (as picked on the map or in 3D) in the stored frame of `mediaLayerId`. */
export const toStore: PinFrame = (p) => [p[0], p[1], p[2]];

/** A stored point of `mediaLayerId` where it draws. */
export const toDraw: PinFrame = (p) => [p[0], p[1], p[2]];
