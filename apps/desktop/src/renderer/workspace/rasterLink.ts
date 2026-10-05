import { createStore } from 'zustand/vanilla';

/**
 * Two ortho panes side by side (two survey dates) pan and zoom together. The shared view is in
 * the project's local frame (x east, z south, metres) when both rasters are placed (`corners`),
 * else in image fractions; a pane converts it to and from its own pixels.
 */
export interface LinkedView {
  /** `geo`: x, z in the local frame. `image`: x, z as fractions of the image width and height. */
  space: 'geo' | 'image';
  x: number;
  z: number;
  /** Units of `space` per screen pixel along the image's x axis. */
  span: number;
  /** The pane that set it (it does not apply its own view again). */
  by: string;
}

export const rasterLink = createStore<{ view: LinkedView | null }>()(() => ({ view: null }));

type V3 = readonly [number, number, number];

/** Where a raster's finest-level pixels lie: an affine map to the shared view space. */
export interface RasterPlacement {
  space: 'geo' | 'image';
  /** Pixel (px, py) of the finest level to (x, z). */
  toView(px: number, py: number): [number, number];
  /** The inverse. */
  toPixel(x: number, z: number): [number, number];
  /** Units of `space` per finest-level pixel along the image's x axis. */
  unitsPerPixel: number;
}

export function placement(
  size: { width: number; height: number },
  corners?: { tl: V3; tr: V3; bl: V3 },
): RasterPlacement {
  const w = Math.max(1, size.width);
  const h = Math.max(1, size.height);
  if (!corners) {
    return {
      space: 'image',
      toView: (px, py) => [px / w, py / h],
      toPixel: (x, z) => [x * w, z * h],
      unitsPerPixel: 1 / w,
    };
  }
  const o = [corners.tl[0], corners.tl[2]] as const;
  const u = [(corners.tr[0] - o[0]) / w, (corners.tr[2] - o[1]) / w] as const;
  const v = [(corners.bl[0] - o[0]) / h, (corners.bl[2] - o[1]) / h] as const;
  const det = u[0] * v[1] - u[1] * v[0];
  return {
    space: 'geo',
    toView: (px, py) => [o[0] + px * u[0] + py * v[0], o[1] + px * u[1] + py * v[1]],
    toPixel: (x, z) => {
      const dx = x - o[0];
      const dz = z - o[1];
      if (Math.abs(det) < 1e-12) return [0, 0];
      return [(dx * v[1] - dz * v[0]) / det, (u[0] * dz - u[1] * dx) / det];
    },
    unitsPerPixel: Math.hypot(u[0], u[1]),
  };
}

/** A pane view (screen px per finest px, offset) as the shared view, centred on the pane. */
export function toLinked(
  view: { scale: number; x: number; y: number },
  box: { width: number; height: number },
  p: RasterPlacement,
  by: string,
): LinkedView {
  const cx = (box.width / 2 - view.x) / view.scale;
  const cy = (box.height / 2 - view.y) / view.scale;
  const [x, z] = p.toView(cx, cy);
  return { space: p.space, x, z, span: p.unitsPerPixel / view.scale, by };
}

/** The shared view as this pane's view; null when the spaces differ. */
export function fromLinked(
  linked: LinkedView,
  box: { width: number; height: number },
  p: RasterPlacement,
): { scale: number; x: number; y: number } | null {
  if (linked.space !== p.space || !(linked.span > 0)) return null;
  const scale = p.unitsPerPixel / linked.span;
  const [cx, cy] = p.toPixel(linked.x, linked.z);
  return { scale, x: box.width / 2 - cx * scale, y: box.height / 2 - cy * scale };
}
