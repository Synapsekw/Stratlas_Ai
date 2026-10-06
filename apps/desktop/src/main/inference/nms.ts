/** A detection box in pixels with its score and class index. */
export interface ScoredBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
  cls: number;
}

const area = (b: ScoredBox) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

function intersection(a: ScoredBox, b: ScoredBox): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Intersection over union. */
export function iou(a: ScoredBox, b: ScoredBox): number {
  const i = intersection(a, b);
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}

/** Intersection over the smaller box: 1 when one box lies inside the other. */
export function ioMin(a: ScoredBox, b: ScoredBox): number {
  const m = Math.min(area(a), area(b));
  return m > 0 ? intersection(a, b) / m : 0;
}

export interface NmsOptions {
  /** Suppress a box whose IoU with a better one of its class is above this. Default 0.45. */
  iou?: number;
  /**
   * Suppress a box lying (almost) wholly inside a better one of its class: a partial view of the
   * same object, as tiles and sliding windows produce. Default 0.9.
   */
  contain?: number;
  maxDetections?: number;
}

/** Greedy per-class non-maximum suppression; the kept boxes, best first. */
export function nms(boxes: readonly ScoredBox[], opts: NmsOptions = {}): ScoredBox[] {
  const maxIou = opts.iou ?? 0.45;
  const contain = opts.contain ?? 0.9;
  const max = opts.maxDetections ?? 300;
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: ScoredBox[] = [];
  for (const b of sorted) {
    if (kept.length >= max) break;
    const dup = kept.some((k) => k.cls === b.cls && (iou(k, b) > maxIou || ioMin(k, b) > contain));
    if (!dup) kept.push(b);
  }
  return kept;
}
