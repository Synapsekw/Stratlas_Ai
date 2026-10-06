/**
 * Pre-processing for local detection: tiles of a large photo, and the letterboxed, normalised
 * input tensor of one tile (the model card's `input`). Pure functions, run in the inference
 * utility process.
 */
import type { DetectorModelCard } from '@aio/schema';
import type { ScoredBox } from './nms';

export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tile origins along one side: steps of `size - overlap`, the last flush with the edge. */
function starts(length: number, size: number, overlap: number): number[] {
  if (length <= size) return [0];
  const step = Math.max(1, size - overlap);
  const out: number[] = [];
  for (let s = 0; s + size < length; s += step) out.push(s);
  out.push(length - size);
  return out;
}

/** Tiles of `size` x `size` covering the photo, rows first. One tile when it fits. */
export function tileGrid(width: number, height: number, size: number, overlap: number): Rect[] {
  const xs = starts(width, size, overlap);
  const ys = starts(height, size, overlap);
  return ys.flatMap((y) =>
    xs.map((x) => ({ x, y, w: Math.min(size, width - x), h: Math.min(size, height - y) })),
  );
}

/** Grey of the letterbox border (the YOLO convention). */
const PAD = 114;

export type InputSpec = DetectorModelCard['input'];

export interface Letterboxed {
  data: Float32Array;
  dims: [number, number, number, number];
  /** Input pixels per tile pixel. */
  scale: number;
  padX: number;
  padY: number;
}

/** The tile scaled to fit the input (aspect kept, bilinear), centred on grey, normalised. */
export function letterbox(img: RgbaImage, tile: Rect, input: InputSpec): Letterboxed {
  const W = input.width;
  const H = input.height;
  const scale = Math.min(W / tile.w, H / tile.h);
  const nw = Math.max(1, Math.round(tile.w * scale));
  const nh = Math.max(1, Math.round(tile.h * scale));
  const padX = Math.floor((W - nw) / 2);
  const padY = Math.floor((H - nh) / 2);
  const div = input.scale ?? 255;
  const mean = input.mean ?? [0, 0, 0];
  const std = input.std ?? [1, 1, 1];
  const order = input.color === 'bgr' ? [2, 1, 0] : [0, 1, 2];
  const nhwc = input.tensor === 'nhwc';
  const data = new Float32Array(3 * W * H);
  const plane = W * H;
  const norm = (v: number, c: number) => (v / div - (mean[c] ?? 0)) / (std[c] ?? 1);
  const put = (x: number, y: number, c: number, v: number) => {
    data[nhwc ? (y * W + x) * 3 + c : c * plane + y * W + x] = v;
  };
  const padValue = [0, 1, 2].map((c) => norm(PAD, c));
  const sx = tile.w / nw;
  const sy = tile.h / nh;
  const px = (x: number, y: number, ch: number) => img.rgba[(y * img.width + x) * 4 + ch] ?? 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ix = x - padX;
      const iy = y - padY;
      if (ix < 0 || iy < 0 || ix >= nw || iy >= nh) {
        for (let c = 0; c < 3; c++) put(x, y, c, padValue[c] ?? 0);
        continue;
      }
      const fx = Math.min(Math.max((ix + 0.5) * sx - 0.5, 0), tile.w - 1);
      const fy = Math.min(Math.max((iy + 0.5) * sy - 0.5, 0), tile.h - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, tile.w - 1);
      const y1 = Math.min(y0 + 1, tile.h - 1);
      const ax = fx - x0;
      const ay = fy - y0;
      for (let c = 0; c < 3; c++) {
        const src = order[c] ?? c;
        const v =
          (px(tile.x + x0, tile.y + y0, src) * (1 - ax) + px(tile.x + x1, tile.y + y0, src) * ax) *
            (1 - ay) +
          (px(tile.x + x0, tile.y + y1, src) * (1 - ax) + px(tile.x + x1, tile.y + y1, src) * ax) *
            ay;
        put(x, y, c, norm(v, c));
      }
    }
  }
  return { data, dims: nhwc ? [1, H, W, 3] : [1, 3, H, W], scale, padX, padY };
}

/** Boxes of the letterboxed input back to photo pixels, clamped to the tile. */
export function unletterbox(boxes: readonly ScoredBox[], lb: Letterboxed, tile: Rect): ScoredBox[] {
  const fx = (v: number) => Math.min(Math.max((v - lb.padX) / lb.scale, 0), tile.w) + tile.x;
  const fy = (v: number) => Math.min(Math.max((v - lb.padY) / lb.scale, 0), tile.h) + tile.y;
  return boxes
    .map((b) => ({ ...b, x0: fx(b.x0), y0: fy(b.y0), x1: fx(b.x1), y1: fy(b.y1) }))
    .filter((b) => b.x1 - b.x0 >= 1 && b.y1 - b.y0 >= 1);
}

/**
 * True when the box touches an edge of its tile that lies inside the photo: with overlapping
 * tiles it may be a cut view of an object a neighbouring tile sees whole.
 */
export function touchesSeam(
  b: ScoredBox,
  tile: Rect,
  photo: { width: number; height: number },
  margin = 2,
): boolean {
  return (
    (tile.x > 0 && b.x0 <= tile.x + margin) ||
    (tile.y > 0 && b.y0 <= tile.y + margin) ||
    (tile.x + tile.w < photo.width && b.x1 >= tile.x + tile.w - margin) ||
    (tile.y + tile.h < photo.height && b.y1 >= tile.y + tile.h - margin)
  );
}
