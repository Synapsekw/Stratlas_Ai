import { describe, expect, it } from 'vitest';
import { rotateBgra90, turnLens90 } from './rotateBgra';

describe('rotateBgra90', () => {
  it('turns a 2 by 1 row so the right pixel is on top', () => {
    const src = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = rotateBgra90(src, 2, 1);
    expect(out.subarray(0, 4)).toEqual(Buffer.from([5, 6, 7, 8]));
    expect(out.subarray(4, 8)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('is back to the start after four turns', () => {
    const src = Buffer.from([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]);
    let buf: Buffer = src;
    let w = 2;
    let h = 2;
    for (let i = 0; i < 4; i++) {
      buf = rotateBgra90(buf, w, h);
      [w, h] = [h, w];
    }
    expect(buf).toEqual(src);
  });
});

describe('turnLens90', () => {
  it('swaps a pinhole field of view and turns the principal point', () => {
    const next = turnLens90({ model: 'pinhole', hfovDeg: 90, aspect: 2, cx: 10, cy: 4 }, 20, 10);
    expect(next.aspect).toBeCloseTo(0.5);
    expect(next.hfovDeg).toBeCloseTo((2 * Math.atan(Math.tan(Math.PI / 4) / 2) * 180) / Math.PI);
    expect(next.cx).toBeCloseTo(6);
    expect(next.cy).toBeCloseTo(10);
  });
});
