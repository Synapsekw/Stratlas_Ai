import { describe, expect, it } from 'vitest';
import { ioMin, iou, nms, type ScoredBox } from './nms';

const box = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  score: number,
  cls = 0,
): ScoredBox => ({
  x0,
  y0,
  x1,
  y1,
  score,
  cls,
});

describe('overlap measures', () => {
  it('computes IoU and intersection over the smaller box', () => {
    expect(iou(box(0, 0, 10, 10, 1), box(0, 0, 10, 10, 1))).toBe(1);
    expect(iou(box(0, 0, 10, 10, 1), box(5, 0, 15, 10, 1))).toBeCloseTo(50 / 150);
    expect(iou(box(0, 0, 10, 10, 1), box(20, 20, 30, 30, 1))).toBe(0);
    expect(ioMin(box(0, 0, 10, 10, 1), box(2, 2, 6, 6, 1))).toBe(1);
  });
});

describe('non-maximum suppression', () => {
  it('keeps the best of overlapping boxes of one class, best first', () => {
    const kept = nms([box(0, 0, 10, 10, 0.6), box(1, 1, 11, 11, 0.9), box(50, 50, 60, 60, 0.5)]);
    expect(kept.map((b) => b.score)).toEqual([0.9, 0.5]);
  });

  it('keeps overlapping boxes of different classes', () => {
    expect(nms([box(0, 0, 10, 10, 0.9, 0), box(0, 0, 10, 10, 0.8, 1)])).toHaveLength(2);
  });

  it('removes a weaker box lying inside a stronger one (a partial view)', () => {
    const kept = nms([box(0, 0, 32, 32, 0.94), box(0, 0, 8, 32, 0.8), box(20, 0, 32, 14, 0.7)]);
    expect(kept).toEqual([box(0, 0, 32, 32, 0.94)]);
  });

  it('caps the number of boxes', () => {
    const many = Array.from({ length: 50 }, (_, i) => box(i * 20, 0, i * 20 + 10, 10, i / 50));
    expect(nms(many, { maxDetections: 10 })).toHaveLength(10);
  });
});
