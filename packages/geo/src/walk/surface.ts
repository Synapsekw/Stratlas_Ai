import type { Vec3 } from '@aio/schema';
import type { SurfaceFrame } from './fit';

/**
 * A drawing's frame for the walk fit from its model-frame corners (top-left, top-right,
 * bottom-left) and its picture size in px: the affine from image px to model x/z, the base height
 * from the top-left corner. A size that is not positive gives a frame that is not finite, which
 * the fit treats as no target.
 */
export function surfaceFrameFromCorners(
  corners: { tl: Vec3; tr: Vec3; bl: Vec3 },
  sizePx: [number, number],
  provisional: boolean,
): SurfaceFrame {
  const [w, h] = sizePx;
  const { tl, tr, bl } = corners;
  return {
    a: (tr[0] - tl[0]) / w,
    c: (tr[2] - tl[2]) / w,
    b: (bl[0] - tl[0]) / h,
    d: (bl[2] - tl[2]) / h,
    tx: tl[0],
    tz: tl[2],
    baseY: tl[1],
    provisional,
  };
}
