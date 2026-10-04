import type { CameraOrientation, LensModel, Quat } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { autoAlign, grayFromRgba, resizeGray, type GrayImage } from './autoalign';
import { imageToRay } from './lens';
import { orientCamera, quatRotate } from './orientation';
import { cameraQuatFromGimbal } from './srt';

const LENS: LensModel = { model: 'pinhole', hfovDeg: 72.2, aspect: 1.8972 };

/** Hash of a cell to a grey level: a patchwork of blocks of different brightness. */
function level(i: number, j: number): number {
  let h = (i * 374761393 + j * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return 40 + ((h >>> 8) % 180);
}

/** The scene as seen along a world direction (rotation only, so no depth needed). */
function world(d: [number, number, number]): number {
  const az = (Math.atan2(d[0], -d[2]) * 180) / Math.PI;
  const el = (Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180) / Math.PI;
  // blocks of 3 x 2 degrees, offset per row so edges do not line up into a regular grid
  const j = Math.floor(el / 2);
  const i = Math.floor((az + (j % 3) * 1.1) / 3);
  return level(i, j);
}

function render(q: Quat, lens: LensModel, width: number): GrayImage {
  const height = Math.round(width / lens.aspect);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const ray = imageToRay(lens, (x + 0.5) / width, (y + 0.5) / height);
      data[y * width + x] = world(quatRotate(q, ray));
    }
  return { width, height, data };
}

describe('autoAlign', () => {
  const q0 = cameraQuatFromGimbal(40, -23, 0);

  for (const truth of [
    { yawDeg: 0.6, pitchDeg: -8.1, rollDeg: 0.4 },
    { yawDeg: -3.3, pitchDeg: 5.2, rollDeg: -1.1 },
  ] satisfies CameraOrientation[]) {
    it(`finds a turn of ${JSON.stringify(truth)} between the render and the frame`, () => {
      const model = render(q0, LENS, 480);
      const frame = render(orientCamera(q0, truth), LENS, 480);
      const r = autoAlign(model, frame, LENS);
      expect(Math.abs(r.delta.yawDeg - truth.yawDeg)).toBeLessThan(0.15);
      expect(Math.abs(r.delta.pitchDeg - truth.pitchDeg)).toBeLessThan(0.15);
      expect(Math.abs(r.delta.rollDeg - truth.rollDeg)).toBeLessThan(0.3);
      expect(r.score).toBeGreaterThan(r.startScore);
      expect(r.contrast).toBeGreaterThan(1);
    });
  }

  it('converts RGBA to grey and resizes', () => {
    const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]);
    const g = grayFromRgba(rgba, 2, 1);
    expect(g.data[0]).toBeCloseTo(255, 3);
    expect(g.data[1]).toBe(0);
    const flipped = grayFromRgba(new Uint8Array([10, 10, 10, 255, 200, 200, 200, 255]), 1, 2, true);
    expect(flipped.data[0]).toBeCloseTo(200, 3);
    const small = resizeGray(
      { width: 4, height: 2, data: new Float32Array([1, 1, 3, 3, 1, 1, 3, 3]) },
      2,
    );
    expect([...small.data]).toEqual([1, 3]);
  });
});
