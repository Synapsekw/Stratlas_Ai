/** Local-frame points to screen pixels: the one projection the antenna labels and card share. */
import type { Vec3 } from '@aio/schema';
import { Vector3, type Camera } from 'three';

const tmp = new Vector3();

/** A rectangle on screen as `getBoundingClientRect` gives it. */
export type ScreenRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

/**
 * A local-frame point on screen, in CSS pixels relative to the host (`hostRect`), for a camera
 * drawing into a canvas at `canvasRect`. `front` is false when the point is behind the camera;
 * `inside` is true when it is in front and within the canvas.
 */
export function projectToHost(
  p: Vec3,
  camera: Camera,
  canvasRect: ScreenRect,
  hostRect: ScreenRect,
): { x: number; y: number; front: boolean; inside: boolean } {
  tmp.set(p[0], p[1], p[2]).project(camera);
  const cx = ((tmp.x + 1) / 2) * canvasRect.width;
  const cy = ((1 - tmp.y) / 2) * canvasRect.height;
  const front = tmp.z <= 1;
  return {
    x: canvasRect.left + cx - hostRect.left,
    y: canvasRect.top + cy - hostRect.top,
    front,
    inside: front && cx >= 0 && cx <= canvasRect.width && cy >= 0 && cy <= canvasRect.height,
  };
}
