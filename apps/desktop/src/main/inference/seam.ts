/**
 * Wrap-aware post-processing for equirectangular (walk, 360 video) frames, where x = width is
 * the same place as x = 0. A box with x1 > width wraps across that seam, its part past width
 * continuing at x = 0 (the stored form of a wrapping frame box). Pure; only walk frames use it.
 *
 * - Tiles (optional): the grid runs on across the seam, built from the frame extended with its
 *   first columns, and the boxes are folded back by one width.
 * - NMS also compares each box with the other shifted by one width, so a box and its twin on the
 *   far side of the seam are one object.
 * - `mergeSeam`: two boxes of a class, one touching x = 0 and the other touching x = width, whose
 *   vertical ranges overlap (IoU over y >= 0.5), are one object the seam cut: they become one
 *   wrapping box.
 */
import { ioMin, iou, type NmsOptions, type ScoredBox } from './nms';
import type { Rect, RgbaImage } from './tile';

/** Tiles of `size` across a frame that wraps: starts every `size - overlap` while inside it. */
export function wrapTileGrid(width: number, height: number, size: number, overlap: number): Rect[] {
  const ys: number[] = [];
  if (height <= size) ys.push(0);
  else {
    const step = Math.max(1, size - overlap);
    for (let s = 0; s + size < height; s += step) ys.push(s);
    ys.push(height - size);
  }
  const h = (y: number) => Math.min(size, height - y);
  if (width <= size) return ys.map((y) => ({ x: 0, y, w: width, h: h(y) }));
  const step = Math.max(1, size - overlap);
  const xs: number[] = [];
  // the last start lies within one step of the width, so the last tile covers the seam with overlap
  for (let s = 0; s < width; s += step) xs.push(s);
  return ys.flatMap((y) => xs.map((x) => ({ x, y, w: size, h: h(y) })));
}

/** The frame with its first columns repeated past the right edge, to `width` pixels in all. */
export function wrapExtend(img: RgbaImage, width: number): RgbaImage {
  if (width <= img.width) return img;
  const rgba = new Uint8Array(width * img.height * 4);
  const row = img.width * 4;
  for (let y = 0; y < img.height; y++) {
    const src = y * row;
    const dst = y * width * 4;
    for (let x = 0; x < width; x += img.width) {
      const n = Math.min(img.width, width - x) * 4;
      rgba.set(img.rgba.subarray(src, src + n), dst + x * 4);
    }
  }
  return { width, height: img.height, rgba };
}

/**
 * True when the box touches a tile edge that cuts the frame. Across a wrapping frame both side
 * edges of every tile are cuts; the top and bottom only inside the frame.
 */
export function touchesTileEdgeWrapped(
  b: ScoredBox,
  tile: Rect,
  height: number,
  margin = 2,
): boolean {
  return (
    b.x0 <= tile.x + margin ||
    b.x1 >= tile.x + tile.w - margin ||
    (tile.y > 0 && b.y0 <= tile.y + margin) ||
    (tile.y + tile.h < height && b.y1 >= tile.y + tile.h - margin)
  );
}

const shift = (b: ScoredBox, dx: number): ScoredBox => ({ ...b, x0: b.x0 + dx, x1: b.x1 + dx });

/** A box starting past the width, moved back by one width (a wrapping box stays as it is). */
export function foldWrap(b: ScoredBox, width: number): ScoredBox {
  return b.x0 >= width ? shift(b, -width) : b;
}

/** IoU of two boxes on a frame that wraps (the best of no shift and one width either way). */
export function iouWrap(a: ScoredBox, b: ScoredBox, width: number): number {
  return Math.max(iou(a, b), iou(a, shift(b, width)), iou(a, shift(b, -width)));
}

/** Intersection over the smaller box on a frame that wraps. */
export function ioMinWrap(a: ScoredBox, b: ScoredBox, width: number): number {
  return Math.max(ioMin(a, b), ioMin(a, shift(b, width)), ioMin(a, shift(b, -width)));
}

/** Greedy per-class NMS on a frame that wraps; the kept boxes, best first. */
export function nmsWrap(
  boxes: readonly ScoredBox[],
  width: number,
  opts: NmsOptions = {},
): ScoredBox[] {
  const maxIou = opts.iou ?? 0.45;
  const contain = opts.contain ?? 0.8;
  const max = opts.maxDetections ?? 300;
  const kept: ScoredBox[] = [];
  for (const b of [...boxes].sort((p, q) => q.score - p.score)) {
    if (kept.length >= max) break;
    const dup = kept.some(
      (k) => k.cls === b.cls && (iouWrap(k, b, width) > maxIou || ioMinWrap(k, b, width) > contain),
    );
    if (!dup) kept.push(b);
  }
  return kept;
}

/** IoU of the vertical ranges of two boxes. */
function yIou(a: ScoredBox, b: ScoredBox): number {
  const i = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const u = Math.max(a.y1, b.y1) - Math.min(a.y0, b.y0);
  return i > 0 && u > 0 ? i / u : 0;
}

export interface SeamOptions {
  /** How close to x = 0 or x = width a box edge counts as touching it, pixels. Default 2. */
  margin?: number;
  /** Least IoU of the vertical ranges for a merge. Default 0.5. */
  minYIou?: number;
}

/**
 * The halves of objects cut by the seam merged: a right half (x1 at the width) and a left half
 * (x0 at 0) of the same class with vertical IoU >= `minYIou` become [right.x0, min y0,
 * width + left.x1, max y1] with the better score. Each half pairs once, best vertical match first;
 * the merged box takes the right half's place and the left half goes. Other boxes are untouched.
 */
export function mergeSeam(
  boxes: readonly ScoredBox[],
  width: number,
  opts: SeamOptions = {},
): ScoredBox[] {
  const m = opts.margin ?? 2;
  const minY = opts.minYIou ?? 0.5;
  const atLeft = (b: ScoredBox) => b.x0 <= m;
  const atRight = (b: ScoredBox) => b.x1 >= width - m && b.x1 <= width + m;
  // a box touching both edges spans the frame: it is not a half
  const lefts = boxes.flatMap((b, i) => (atLeft(b) && !atRight(b) ? [i] : []));
  const rights = boxes.flatMap((b, i) => (atRight(b) && !atLeft(b) ? [i] : []));
  const pairs: { l: number; r: number; v: number }[] = [];
  for (const l of lefts)
    for (const r of rights) {
      const a = boxes[l];
      const b = boxes[r];
      if (!a || a.cls !== b?.cls) continue;
      const v = yIou(a, b);
      if (v >= minY) pairs.push({ l, r, v });
    }
  pairs.sort((p, q) => q.v - p.v);
  const merged = new Map<number, ScoredBox>();
  const gone = new Set<number>();
  for (const { l, r } of pairs) {
    if (gone.has(l) || merged.has(r)) continue;
    const a = boxes[l];
    const b = boxes[r];
    if (!a || !b) continue;
    merged.set(r, {
      x0: b.x0,
      y0: Math.min(a.y0, b.y0),
      x1: width + a.x1,
      y1: Math.max(a.y1, b.y1),
      score: Math.max(a.score, b.score),
      cls: b.cls,
    });
    gone.add(l);
  }
  return boxes.flatMap((b, i) => (gone.has(i) ? [] : [merged.get(i) ?? b]));
}

/**
 * How near x = 0 or x = width (source pixels) a box edge counts as touching the seam, for a frame
 * decoded at `scale` (decoded / source): 6 decoded pixels or 1 % of the width, whichever is more.
 * A model's box for a cut half often stops a few pixels short of the edge.
 */
export const seamMargin = (width: number, scale: number) => Math.max(6 / scale, 0.01 * width);

/**
 * A walk frame's boxes (source pixels) as a run stores them: a box that rounding moved onto the
 * width folded back into the frame, the halves the seam cut merged (`seamMargin`), and NMS across
 * the seam. The vertical IoU rule of `mergeSeam` keeps different people apart.
 */
export function frameBoxes(boxes: readonly ScoredBox[], width: number, scale: number): ScoredBox[] {
  const folded = boxes.map((b) => foldWrap(b, width));
  return nmsWrap(mergeSeam(folded, width, { margin: seamMargin(width, scale) }), width);
}
