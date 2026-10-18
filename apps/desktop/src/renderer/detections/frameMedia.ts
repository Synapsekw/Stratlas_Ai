/**
 * Frames in the review: which video a frame detection is on (a video layer's clip, or a walk's
 * playback copy, the unlevelled one the detector saw), and how a box that wraps across a walk's
 * 360 seam is drawn on the flat frame. Pure.
 */
import type { AssetRef, ImageGeom, Layer } from '@aio/schema';

/** The video of a frame source's layer: a video clip or a walk's playback copy. */
export function frameLayerSrc(layers: readonly Layer[], layerId: string): AssetRef | null {
  const layer = layers.find((l) => l.id === layerId);
  return layer?.kind === 'video' || layer?.kind === 'walk' ? layer.src : null;
}

/**
 * The parts of a shape to draw on a frame `width` wide. A box with x + w > width wraps across the
 * 360 seam (a walk frame): it is drawn as [x, width] and [0, x + w - width]. Anything else is
 * drawn as it is.
 */
export function wrapParts<G extends ImageGeom>(g: G, width: number): G[] {
  if (g.type !== 'box' || !(width > 0) || g.x + g.w <= width) return [g];
  const right = width - g.x;
  const left = g.x + g.w - width;
  if (right <= 0 || left <= 0) return [g];
  return [
    { ...g, w: right },
    { ...g, x: 0, w: left },
  ];
}

const WRAP = '\u0000wrap';

/** The shape key of the second part of a wrapping box. */
export const wrapKey = (id: string) => `${id}${WRAP}`;

/** The detection id behind a shape key (either part of a wrapping box). */
export const splitWrapKey = (key: string) =>
  key.endsWith(WRAP) ? key.slice(0, -WRAP.length) : key;
