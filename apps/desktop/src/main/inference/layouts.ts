/**
 * Post-processing per output layout (`DetectorLayout`, data-conventions section 16): the model's
 * output tensors to boxes in input pixels (the letterboxed tensor), with the best class and its
 * score. Pure; NMS and the mapping back to the photo come after.
 *
 * - `yolo-v8`: one output `[1, 4 + C, N]` (or `[1, N, 4 + C]`): centre x, centre y, width, height
 *   in input pixels, then C class scores.
 * - `yolo-v5`: one output `[1, N, 5 + C]` (or transposed): box, objectness, C class scores.
 * - `detr`: logits `[1, Q, C + 1]` (softmax, last is "no object") or `[1, Q, C]` (sigmoid) and
 *   boxes `[1, Q, 4]` as normalised centre x, centre y, width, height.
 * - `ssd`: boxes `[1, N, 4]` as normalised `[ymin, xmin, ymax, xmax]`, classes `[1, N]` and scores
 *   `[1, N]` (found by name, else in that order), an optional count.
 * - `generic`: one output `[N, 6]` or `[1, N, 6]`: `x0, y0, x1, y1, score, class` in input pixels.
 *
 * Class indexes start at 0 and index the card's `classes`.
 */
import type { DetectorLayout } from '@aio/schema';
import type { ScoredBox } from './nms';

export interface NamedTensor {
  name: string;
  dims: readonly number[];
  data: ArrayLike<number>;
}

export interface DecodeOptions {
  classes: number;
  input: { width: number; height: number };
  minConfidence: number;
}

const shape = (dims: readonly number[]) => `[${dims.join(', ')}]`;
const val = (t: NamedTensor, i: number) => t.data[i] ?? 0;

/** A matrix view of a 2-D or batch-1 3-D tensor: `rows` x `cols`, optionally transposed. */
interface Rows {
  rows: number;
  cols: number;
  at(r: number, c: number): number;
}

function rowsOf(t: NamedTensor, width: number): Rows | null {
  const d = t.dims;
  const [a, b] =
    d.length === 3 && d[0] === 1
      ? [d[1] ?? 0, d[2] ?? 0]
      : d.length === 2
        ? [d[0] ?? 0, d[1] ?? 0]
        : [-1, -1];
  if (a < 0) return null;
  // rows of `width` values; prefer channels-first ([width, N]) as YOLOv8 exports
  if (a === width && d.length === 3) return { rows: b, cols: a, at: (r, c) => val(t, c * b + r) };
  if (b === width) return { rows: a, cols: b, at: (r, c) => val(t, r * b + c) };
  if (a === width) return { rows: b, cols: a, at: (r, c) => val(t, c * b + r) };
  return null;
}

function best(scores: (c: number) => number, n: number): [number, number] {
  let cls = 0;
  let score = -Infinity;
  for (let c = 0; c < n; c++) {
    const s = scores(c);
    if (s > score) {
      score = s;
      cls = c;
    }
  }
  return [cls, score];
}

const centre = (
  cx: number,
  cy: number,
  w: number,
  h: number,
  score: number,
  cls: number,
): ScoredBox => ({
  x0: cx - w / 2,
  y0: cy - h / 2,
  x1: cx + w / 2,
  y1: cy + h / 2,
  score,
  cls,
});

function detrParts(outputs: readonly NamedTensor[], classes: number) {
  const three = outputs.filter((o) => o.dims.length === 3);
  const boxes =
    three.find((o) => o.dims[2] === 4 && /box/i.test(o.name)) ?? three.find((o) => o.dims[2] === 4);
  const logits = three.find(
    (o) => o !== boxes && (o.dims[2] === classes + 1 || o.dims[2] === classes),
  );
  if (!boxes || !logits || boxes.dims[1] !== logits.dims[1]) return null;
  return { boxes, logits };
}

function ssdParts(outputs: readonly NamedTensor[]) {
  const boxes = outputs.find((o) => o.dims.length === 3 && o.dims[2] === 4);
  const flat = outputs.filter((o) => o !== boxes && o.dims.length === 2 && o.dims[0] === 1);
  const named = (re: RegExp) => flat.find((o) => re.test(o.name));
  const classes = named(/class/i) ?? flat[0];
  const scores = named(/score/i) ?? flat.find((o) => o !== classes);
  if (!boxes || !classes || !scores) return null;
  const n = boxes.dims[1] ?? 0;
  if (classes.dims[1] !== n || scores.dims[1] !== n) return null;
  return { boxes, classes, scores, n };
}

/** Why the outputs do not fit the layout, or null when they do. */
export function layoutProblem(
  layout: DetectorLayout,
  outputs: readonly NamedTensor[],
  classes: number,
): string | null {
  const got = outputs.map((o) => shape(o.dims)).join(' and ') || 'no output';
  const first = outputs[0];
  switch (layout) {
    case 'yolo-v8':
      return first && outputs.length === 1 && rowsOf(first, 4 + classes)
        ? null
        : `The model card says yolo-v8, which gives one output [1, ${4 + classes}, N] (4 box values and ${classes} class scores per row), but this model gives ${got}.`;
    case 'yolo-v5':
      return first && outputs.length === 1 && rowsOf(first, 5 + classes)
        ? null
        : `The model card says yolo-v5, which gives one output [1, N, ${5 + classes}] (4 box values, objectness and ${classes} class scores per row), but this model gives ${got}.`;
    case 'detr':
      return detrParts(outputs, classes)
        ? null
        : `The model card says detr, which gives class logits [1, Q, ${classes + 1}] and boxes [1, Q, 4], but this model gives ${got}.`;
    case 'ssd':
      return ssdParts(outputs)
        ? null
        : `The model card says ssd, which gives boxes [1, N, 4], classes [1, N] and scores [1, N], but this model gives ${got}.`;
    case 'generic':
      return first && outputs.length === 1 && rowsOf(first, 6)
        ? null
        : `The model card says generic, which gives one output [N, 6] (x0, y0, x1, y1, score, class), but this model gives ${got}.`;
  }
}

/** Boxes in input pixels with a score of at least `minConfidence` (no NMS yet). */
export function decodeOutputs(
  layout: DetectorLayout,
  outputs: readonly NamedTensor[],
  o: DecodeOptions,
): ScoredBox[] {
  if (layoutProblem(layout, outputs, o.classes)) return [];
  const out: ScoredBox[] = [];
  const keep = (b: ScoredBox) => {
    if (b.score >= o.minConfidence && b.cls >= 0 && b.cls < o.classes && b.x1 > b.x0 && b.y1 > b.y0)
      out.push(b);
  };
  const { width: W, height: H } = o.input;
  const first = outputs[0];
  if ((layout === 'yolo-v8' || layout === 'yolo-v5') && first) {
    const v5 = layout === 'yolo-v5';
    const m = rowsOf(first, (v5 ? 5 : 4) + o.classes);
    if (!m) return [];
    for (let r = 0; r < m.rows; r++) {
      const obj = v5 ? m.at(r, 4) : 1;
      if (obj < o.minConfidence) continue;
      const [cls, s] = best((c) => m.at(r, (v5 ? 5 : 4) + c), o.classes);
      keep(centre(m.at(r, 0), m.at(r, 1), m.at(r, 2), m.at(r, 3), s * obj, cls));
    }
  } else if (layout === 'detr') {
    const p = detrParts(outputs, o.classes);
    if (!p) return [];
    const q = p.logits.dims[1] ?? 0;
    const k = p.logits.dims[2] ?? 0;
    const softmax = k === o.classes + 1;
    for (let r = 0; r < q; r++) {
      const logit = (c: number) => val(p.logits, r * k + c);
      let probs: (c: number) => number;
      if (softmax) {
        let max = -Infinity;
        for (let c = 0; c < k; c++) max = Math.max(max, logit(c));
        let sum = 0;
        for (let c = 0; c < k; c++) sum += Math.exp(logit(c) - max);
        probs = (c) => Math.exp(logit(c) - max) / sum;
      } else {
        probs = (c) => 1 / (1 + Math.exp(-logit(c)));
      }
      const [cls, s] = best(probs, o.classes);
      const b = (i: number) => val(p.boxes, r * 4 + i);
      keep(centre(b(0) * W, b(1) * H, b(2) * W, b(3) * H, s, cls));
    }
  } else if (layout === 'ssd') {
    const p = ssdParts(outputs);
    if (!p) return [];
    for (let r = 0; r < p.n; r++) {
      const b = (i: number) => val(p.boxes, r * 4 + i);
      keep({
        x0: b(1) * W,
        y0: b(0) * H,
        x1: b(3) * W,
        y1: b(2) * H,
        score: val(p.scores, r),
        cls: Math.round(val(p.classes, r)),
      });
    }
  } else if (first) {
    const m = rowsOf(first, 6);
    if (!m) return [];
    for (let r = 0; r < m.rows; r++) {
      keep({
        x0: m.at(r, 0),
        y0: m.at(r, 1),
        x1: m.at(r, 2),
        y1: m.at(r, 3),
        score: m.at(r, 4),
        cls: Math.round(m.at(r, 5)),
      });
    }
  }
  return out;
}
