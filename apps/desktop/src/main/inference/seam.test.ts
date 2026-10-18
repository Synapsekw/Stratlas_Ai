import { describe, expect, it } from 'vitest';
import type { ScoredBox } from './nms';
import {
  foldWrap,
  iouWrap,
  mergeSeam,
  nmsWrap,
  touchesTileEdgeWrapped,
  wrapExtend,
  wrapTileGrid,
} from './seam';

const box = (x0: number, y0: number, x1: number, y1: number, score = 0.9, cls = 0): ScoredBox => ({
  x0,
  y0,
  x1,
  y1,
  score,
  cls,
});

describe('mergeSeam', () => {
  const W = 3840;

  it('merges the two halves of an object cut by the seam into one wrapping box', () => {
    const right = box(3790, 900, 3840, 1000, 0.8);
    const left = box(0, 905, 30, 1004, 0.95);
    expect(mergeSeam([right, left], W)).toEqual([box(3790, 900, 3870, 1004, 0.95)]);
  });

  it('keeps the halves apart for different classes', () => {
    const boxes = [box(3790, 900, 3840, 1000, 0.8, 0), box(0, 900, 30, 1000, 0.9, 1)];
    expect(mergeSeam(boxes, W)).toEqual(boxes);
  });

  it('keeps the halves apart without vertical overlap', () => {
    const boxes = [box(3790, 900, 3840, 1000), box(0, 1100, 30, 1200)];
    expect(mergeSeam(boxes, W)).toEqual(boxes);
  });

  it('keeps the halves apart when they overlap vertically by less than half', () => {
    // y IoU 40 / 160 = 0.25
    const boxes = [box(3790, 900, 3840, 1000), box(0, 960, 30, 1060)];
    expect(mergeSeam(boxes, W)).toEqual(boxes);
  });

  it('leaves boxes away from the edges untouched', () => {
    const boxes = [box(100, 900, 200, 1000), box(3600, 900, 3700, 1000), box(10, 50, 40, 90)];
    expect(mergeSeam(boxes, W)).toEqual(boxes);
  });

  it('pairs each half once, the best vertical match first', () => {
    const right = box(3800, 900, 3840, 1000, 0.7);
    const leftA = box(0, 940, 20, 1040, 0.9); // y IoU 60 / 140
    const leftB = box(1, 902, 25, 1001, 0.6); // y IoU 98 / 101
    const out = mergeSeam([right, leftA, leftB], W);
    expect(out).toContainEqual(box(3800, 900, 3865, 1001, 0.7));
    expect(out).toContainEqual(leftA);
    expect(out).toHaveLength(2);
  });

  it('accepts a wider margin (a frame decoded at a lower width)', () => {
    const boxes = [box(3790, 900, 3834, 1000), box(5, 900, 30, 1000)];
    expect(mergeSeam(boxes, W)).toEqual(boxes);
    expect(mergeSeam(boxes, W, { margin: 12 })).toEqual([box(3790, 900, 3870, 1000)]);
  });

  it('does not merge a box spanning the whole width', () => {
    const boxes = [box(0, 0, 3840, 100), box(3800, 0, 3840, 100)];
    expect(mergeSeam(boxes, W)).toEqual(boxes);
  });
});

describe('wrap-aware NMS', () => {
  const W = 1000;

  it('sees a wrapping box and its folded twin as the same object', () => {
    expect(iouWrap(box(950, 0, 1050, 100), box(-50, 0, 50, 100), W)).toBeCloseTo(1);
    // a part at the left edge lies inside the wrapping box
    const kept = nmsWrap([box(950, 0, 1050, 100, 0.9), box(0, 0, 50, 100, 0.5)], W);
    expect(kept).toEqual([box(950, 0, 1050, 100, 0.9)]);
  });

  it('keeps boxes that only overlap after a shift of a different class', () => {
    const boxes = [box(950, 0, 1050, 100, 0.9, 0), box(0, 0, 50, 100, 0.5, 1)];
    expect(nmsWrap(boxes, W)).toEqual(boxes);
  });

  it('folds boxes past the width back by one width', () => {
    expect(foldWrap(box(1010, 0, 1080, 10), W)).toEqual(box(10, 0, 80, 10));
    expect(foldWrap(box(990, 0, 1080, 10), W)).toEqual(box(990, 0, 1080, 10));
    expect(foldWrap(box(10, 0, 80, 10), W)).toEqual(box(10, 0, 80, 10));
  });
});

describe('wrapping tiles', () => {
  it('runs the grid across the seam, the last tile continuing from x = 0', () => {
    const tiles = wrapTileGrid(1000, 300, 400, 100);
    expect(tiles.map((t) => [t.x, t.y, t.w, t.h])).toEqual([
      [0, 0, 400, 300],
      [300, 0, 400, 300],
      [600, 0, 400, 300],
      [900, 0, 400, 300],
    ]);
  });

  it('is the plain grid when the frame fits one tile across', () => {
    expect(wrapTileGrid(300, 200, 400, 50)).toEqual([{ x: 0, y: 0, w: 300, h: 200 }]);
  });

  it('extends the frame with its first columns', () => {
    const rgba = new Uint8Array([
      1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6,
    ]);
    const ext = wrapExtend({ width: 3, height: 2, rgba }, 5);
    expect(ext.width).toBe(5);
    expect([...ext.rgba].filter((_, i) => i % 4 === 0)).toEqual([1, 2, 3, 1, 2, 4, 5, 6, 4, 5]);
  });

  it('treats both side edges of a tile as cuts, top and bottom only inside the frame', () => {
    const tile = { x: 0, y: 0, w: 400, h: 300 };
    expect(touchesTileEdgeWrapped(box(0, 50, 40, 90), tile, 300)).toBe(true);
    expect(touchesTileEdgeWrapped(box(360, 50, 400, 90), tile, 300)).toBe(true);
    expect(touchesTileEdgeWrapped(box(100, 0, 140, 300), tile, 300)).toBe(false);
    expect(touchesTileEdgeWrapped(box(100, 50, 140, 200), { ...tile, h: 200 }, 600)).toBe(true);
  });
});
