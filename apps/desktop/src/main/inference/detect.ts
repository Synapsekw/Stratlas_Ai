/**
 * Detection on one decoded photo: tile it (optional), letterbox each tile into the model input,
 * run the model, decode the outputs per layout, map boxes back to the photo and merge them with
 * NMS. A box cut by an inner tile seam is dropped when another tile sees the same object whole,
 * so an object across a seam is kept once. Runs in the inference utility process.
 */
import type { DetectorModelCard } from '@aio/schema';
import { decodeOutputs, type NamedTensor } from './layouts';
import { ioMin, iou, nms, type ScoredBox } from './nms';
import { letterbox, tileGrid, touchesSeam, unletterbox, type RgbaImage } from './tile';

export interface DetectOptions {
  card: DetectorModelCard;
  minConfidence: number;
  tile?: { size: number; overlap: number };
  /** Decoded pixels per photo pixel (the photo may arrive scaled down). Default 1. */
  scale?: number;
}

/** One model run on an input tensor; the outputs in the session's output order. */
export type RunModel = (input: {
  data: Float32Array;
  dims: readonly number[];
}) => Promise<NamedTensor[]>;

const round = (v: number) => Math.round(v * 10) / 10;

/** Boxes in photo pixels, best first. */
export async function detectImage(
  img: RgbaImage,
  opts: DetectOptions,
  run: RunModel,
): Promise<ScoredBox[]> {
  const { card } = opts;
  const tiles = opts.tile
    ? tileGrid(img.width, img.height, opts.tile.size, opts.tile.overlap)
    : [{ x: 0, y: 0, w: img.width, h: img.height }];
  const whole: ScoredBox[] = [];
  const cut: ScoredBox[] = [];
  for (const tile of tiles) {
    const lb = letterbox(img, tile, card.input);
    const outputs = await run({ data: lb.data, dims: lb.dims });
    const boxes = decodeOutputs(card.layout, outputs, {
      classes: card.classes.length,
      input: card.input,
      minConfidence: opts.minConfidence,
    });
    for (const b of unletterbox(boxes, lb, tile)) {
      (tiles.length > 1 && touchesSeam(b, tile, img) ? cut : whole).push(b);
    }
  }
  const kept = nms(whole);
  for (const b of nms(cut)) {
    const seen = kept.some((k) => k.cls === b.cls && (iou(k, b) > 0.45 || ioMin(k, b) > 0.5));
    if (!seen) kept.push(b);
  }
  const s = opts.scale ?? 1;
  return nms(kept).map((b) => ({
    ...b,
    x0: round(b.x0 / s),
    y0: round(b.y0 / s),
    x1: round(b.x1 / s),
    y1: round(b.y1 / s),
  }));
}
