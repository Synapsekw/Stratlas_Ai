import { describe, expect, it } from 'vitest';
import { cameraQuatFromGimbal, correctQuat } from '@aio/geo';
import type { LensModel, Quat } from '@aio/schema';
import { pixelToWorldRay } from '../../../../packages/annotate/src/crossview/lens';
import { rotateBgra90, turnLens90, turnQuat90 } from './rotateBgra';

describe('rotateBgra90', () => {
  it('turns an asymmetric 2 by 3 image clockwise, retaining all BGRA channels', () => {
    const pixel = (v: number) => [v, v + 10, v + 20, 255];
    const src = Buffer.from([1, 2, 3, 4, 5, 6].flatMap(pixel));
    expect(rotateBgra90(src, 2, 3)).toEqual(Buffer.from([5, 3, 1, 6, 4, 2].flatMap(pixel)));
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

describe('posed photo rotation', () => {
  it.each(['pinhole', 'ftheta'] as const)(
    'preserves %s world rays, including user corrections',
    (model) => {
      let lens: LensModel = { model, hfovDeg: 90, aspect: 2 };
      let q: Quat = cameraQuatFromGimbal(38, -24, 17);
      const originalQ = q;
      const originalLens = lens;
      const correction = { yawDeg: 12, pitchDeg: -3, rollDeg: 8 };
      let width = 400;
      let height = 200;
      let pixel: [number, number] = [73.5, 41.5];
      const ray = () =>
        pixelToWorldRay({ pos: [1, 2, 3], q: correctQuat(q, correction) }, lens, pixel, [
          width,
          height,
        ]).dir;
      const before = ray();
      for (let i = 0; i < 4; i++) {
        lens = turnLens90(lens, width, height);
        q = turnQuat90(q);
        pixel = [height - pixel[1], pixel[0]];
        [width, height] = [height, width];
        ray().forEach((v, axis) => {
          expect(v).toBeCloseTo(before[axis] ?? 0, 10);
        });
      }
      expect(lens.hfovDeg).toBeCloseTo(originalLens.hfovDeg);
      q.forEach((v, axis) => {
        expect(Math.abs(v)).toBeCloseTo(Math.abs(originalQ[axis] ?? 0), 10);
      });
    },
  );

  it('refuses an f-theta field of view that cannot be represented after rotation', () => {
    expect(() => turnLens90({ model: 'ftheta', hfovDeg: 300, aspect: 0.5 }, 100, 200)).toThrow(
      /field of view/i,
    );
  });
});

describe('turnLens90', () => {
  it('turns a partial principal point and OpenCV tangential coefficients with the image axes', () => {
    expect(
      turnLens90({ model: 'pinhole', hfovDeg: 90, aspect: 2, cx: 3, p1: 0.1, p2: 0.2 }, 20, 10),
    ).toMatchObject({ cx: 5, cy: 3, p1: 0.2, p2: -0.1 });
  });

  it('swaps a pinhole field of view and turns the principal point', () => {
    const next = turnLens90({ model: 'pinhole', hfovDeg: 90, aspect: 2, cx: 10, cy: 4 }, 20, 10);
    expect(next.aspect).toBeCloseTo(0.5);
    expect(next.hfovDeg).toBeCloseTo((2 * Math.atan(Math.tan(Math.PI / 4) / 2) * 180) / Math.PI);
    expect(next.cx).toBeCloseTo(6);
    expect(next.cy).toBeCloseTo(10);
  });
});
