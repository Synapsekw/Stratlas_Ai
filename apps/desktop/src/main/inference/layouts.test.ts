import { describe, expect, it } from 'vitest';
import { decodeOutputs, layoutProblem, type NamedTensor } from './layouts';

const t = (name: string, dims: number[], data: number[]): NamedTensor => ({
  name,
  dims,
  data: Float32Array.from(data),
});
const input = { width: 320, height: 240 };
const dec = (...a: Parameters<typeof decodeOutputs>) =>
  decodeOutputs(...a).map((b) => ({ ...b, score: Math.round(b.score * 1e4) / 1e4 }));

describe('yolo-v8 outputs', () => {
  // [1, 4 + 2, 3]: rows cx, cy, w, h, class 0, class 1; columns are anchors
  const out = t(
    'output0',
    [1, 6, 3],
    [
      ...[100, 50, 10], // cx
      ...[100, 60, 10], // cy
      ...[20, 10, 4], // w
      ...[40, 10, 4], // h
      ...[0.9, 0.1, 0.0], // marker
      ...[0.2, 0.7, 0.1], // cyan
    ],
  );

  it('decodes centre boxes and the best class above the threshold', () => {
    const boxes = dec('yolo-v8', [out], { classes: 2, input, minConfidence: 0.5 });
    expect(boxes).toEqual([
      { x0: 90, y0: 80, x1: 110, y1: 120, score: 0.9, cls: 0 },
      { x0: 45, y0: 55, x1: 55, y1: 65, score: 0.7, cls: 1 },
    ]);
  });

  it('reads the transposed export [1, N, 4 + classes] too', () => {
    const tr = t('output0', [1, 1, 6], [100, 100, 20, 40, 0.1, 0.8]);
    expect(dec('yolo-v8', [tr], { classes: 2, input, minConfidence: 0.5 })).toEqual([
      { x0: 90, y0: 80, x1: 110, y1: 120, score: 0.8, cls: 1 },
    ]);
  });

  it('names the expected shape when the output does not fit', () => {
    expect(layoutProblem('yolo-v8', [out], 2)).toBeNull();
    expect(layoutProblem('yolo-v8', [t('o', [1, 18], [])], 2)).toBe(
      'The model card says yolo-v8, which gives one output [1, 6, N] (4 box values and 2 class scores per row), but this model gives [1, 18].',
    );
    expect(layoutProblem('yolo-v8', [out], 3)).toContain('[1, 7, N]');
  });
});

describe('yolo-v5 outputs', () => {
  it('multiplies objectness and class score', () => {
    const out = t(
      'output',
      [1, 2, 7],
      [...[100, 100, 20, 40, 0.9, 0.9, 0.1], ...[10, 10, 4, 4, 0.2, 0.9, 0.1]],
    );
    const boxes = dec('yolo-v5', [out], { classes: 2, input, minConfidence: 0.5 });
    expect(boxes).toEqual([{ x0: 90, y0: 80, x1: 110, y1: 120, score: 0.81, cls: 0 }]);
    expect(layoutProblem('yolo-v5', [out], 3)).toContain('[1, N, 8]');
  });
});

describe('detr outputs', () => {
  it('softmaxes logits with a no-object class and scales normalised boxes', () => {
    const logits = t('pred_logits', [1, 2, 3], [...[4, 0, 0], ...[0, 0, 4]]);
    const boxes = t('pred_boxes', [1, 2, 4], [...[0.5, 0.5, 0.25, 0.5], ...[0.1, 0.1, 0.1, 0.1]]);
    const out = dec('detr', [logits, boxes], { classes: 2, input, minConfidence: 0.5 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ x0: 120, y0: 60, x1: 200, y1: 180, cls: 0 });
    expect(out[0]?.score).toBeGreaterThan(0.9);
    expect(layoutProblem('detr', [logits], 2)).toContain('detr');
  });
});

describe('ssd outputs', () => {
  it('reads normalised [ymin, xmin, ymax, xmax] boxes, classes and scores', () => {
    const out = dec(
      'ssd',
      [
        t('detection_boxes', [1, 2, 4], [...[0.25, 0.25, 0.75, 0.5], ...[0, 0, 0.1, 0.1]]),
        t('detection_classes', [1, 2], [1, 0]),
        t('detection_scores', [1, 2], [0.95, 0.3]),
        t('num_detections', [1], [2]),
      ],
      { classes: 2, input, minConfidence: 0.5 },
    );
    expect(out).toEqual([{ x0: 80, y0: 60, x1: 160, y1: 180, score: 0.95, cls: 1 }]);
  });
});

describe('generic outputs', () => {
  it('reads [x0, y0, x1, y1, score, class] rows', () => {
    const out = dec(
      'generic',
      [t('dets', [1, 2, 6], [...[1, 2, 30, 40, 0.8, 1], ...[0, 0, 5, 5, 0.1, 0]])],
      {
        classes: 2,
        input,
        minConfidence: 0.5,
      },
    );
    expect(out).toEqual([{ x0: 1, y0: 2, x1: 30, y1: 40, score: 0.8, cls: 1 }]);
    expect(layoutProblem('generic', [t('dets', [1, 2, 5], [])], 2)).toContain('[N, 6]');
  });

  it('ignores rows with a class the card does not have', () => {
    const out = dec('generic', [t('dets', [1, 6], [1, 2, 30, 40, 0.8, 7])], {
      classes: 2,
      input,
      minConfidence: 0.5,
    });
    expect(out).toEqual([]);
  });
});
