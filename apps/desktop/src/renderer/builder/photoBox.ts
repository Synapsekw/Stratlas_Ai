import type { PhotoPick } from '@aio/ui';

/** The photos whose screen point lies in the box, whichever way it was dragged. */
export function photosInRect(
  points: readonly (PhotoPick & { x: number; y: number })[],
  r: { x0: number; y0: number; x1: number; y1: number },
): PhotoPick[] {
  const x0 = Math.min(r.x0, r.x1);
  const x1 = Math.max(r.x0, r.x1);
  const y0 = Math.min(r.y0, r.y1);
  const y1 = Math.max(r.y0, r.y1);
  return points
    .filter((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)
    .map((p) => ({ layerId: p.layerId, photoId: p.photoId }));
}
