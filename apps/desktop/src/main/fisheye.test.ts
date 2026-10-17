import { describe, expect, it } from 'vitest';
import { FISHEYE_GREY, greyFromBgra, looksDualFisheye } from './fisheye';

const { width: W, height: H } = FISHEYE_GREY;

function image(px: (x: number, y: number) => number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = px(x, y);
  return out;
}

/** Two bright discs on black: an unstitched Insta360 still, shrunk. */
const twoDiscs = image((x, y) => {
  const a = Math.hypot(x + 0.5 - 16, y + 0.5 - 16);
  const b = Math.hypot(x + 0.5 - 48, y + 0.5 - 16);
  return Math.min(a, b) <= 15 ? 180 : 0;
});
const grey = image(() => 128);
/** An equirect: bright sky on top, darker ground below, nothing black in the corners. */
const skyOverGround = image((_x, y) => 230 - y * 6);
/** A night 360: everything dark, the circles too. */
const night = image(() => 5);

describe('looksDualFisheye', () => {
  it('takes two bright discs on black for an unstitched still', () => {
    expect(looksDualFisheye(twoDiscs, W, H)).toBe(true);
  });

  it('does not take a uniform grey image, a sky over ground, or a dark scene for one', () => {
    expect(looksDualFisheye(grey, W, H)).toBe(false);
    expect(looksDualFisheye(skyOverGround, W, H)).toBe(false);
    expect(looksDualFisheye(night, W, H)).toBe(false);
  });

  it('does not take a night equirect (black sky and ground, a lit horizon band) for one', () => {
    for (const band of [40, 60, 90])
      for (const blackRows of [5, 8]) {
        const nightBand = image((_x, y) => (y < blackRows || y >= H - blackRows ? 4 : band));
        expect(looksDualFisheye(nightBand, W, H)).toBe(false);
      }
  });

  it('refuses any other size than the 64 x 32 it is judged on', () => {
    expect(looksDualFisheye(new Uint8Array(32 * 16), 32, 16)).toBe(false);
    expect(looksDualFisheye(new Uint8Array(10), W, H)).toBe(false);
  });
});

describe('greyFromBgra', () => {
  it('turns BGRA pixels into luma', () => {
    const bgra = new Uint8Array([0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
    expect([...greyFromBgra(bgra, 3, 1)]).toEqual([76, 255, 0]);
  });
});
