import { describe, expect, it } from 'vitest';
import { letterbox, tileGrid, touchesSeam, type RgbaImage } from './tile';

function solid(width: number, height: number, rgb: [number, number, number]): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([...rgb, 255], i * 4);
  return { width, height, rgba };
}

describe('tile grid', () => {
  it('is one tile when the photo fits', () => {
    expect(tileGrid(300, 200, 320, 32)).toEqual([{ x: 0, y: 0, w: 300, h: 200 }]);
  });

  it('covers the photo with overlapping tiles, the last flush with the edge', () => {
    const tiles = tileGrid(1000, 600, 400, 100);
    expect(tiles.map((t) => [t.x, t.y])).toEqual([
      [0, 0],
      [300, 0],
      [600, 0],
      [0, 200],
      [300, 200],
      [600, 200],
    ]);
    expect(tiles.every((t) => t.w === 400 && t.h === 400)).toBe(true);
  });
});

describe('letterbox', () => {
  it('scales into the input, pads, normalises and lays out NCHW RGB', () => {
    const img = solid(200, 100, [255, 0, 51]);
    const lb = letterbox(img, { x: 0, y: 0, w: 200, h: 100 }, { width: 100, height: 100 });
    expect(lb.scale).toBe(0.5);
    expect(lb.padX).toBe(0);
    expect(lb.padY).toBe(25);
    expect(lb.dims).toEqual([1, 3, 100, 100]);
    const plane = 100 * 100;
    const at = (c: number, x: number, y: number) => lb.data[c * plane + y * 100 + x] ?? NaN;
    // inside: the colour / 255
    expect(at(0, 50, 50)).toBeCloseTo(1);
    expect(at(1, 50, 50)).toBeCloseTo(0);
    expect(at(2, 50, 50)).toBeCloseTo(0.2);
    // padding: grey 114
    expect(at(0, 50, 5)).toBeCloseTo(114 / 255);
  });

  it('applies mean and std, BGR order and NHWC', () => {
    const img = solid(10, 10, [255, 128, 0]);
    const lb = letterbox(
      img,
      { x: 0, y: 0, w: 10, h: 10 },
      {
        width: 10,
        height: 10,
        tensor: 'nhwc',
        color: 'bgr',
        scale: 1,
        mean: [100, 100, 100],
        std: [2, 2, 2],
      },
    );
    expect(lb.dims).toEqual([1, 10, 10, 3]);
    expect([...lb.data.slice(0, 3)]).toEqual([-50, 14, 77.5]);
  });

  it('reads only its tile', () => {
    const img = solid(20, 10, [0, 0, 0]);
    // right half white
    for (let y = 0; y < 10; y++)
      for (let x = 10; x < 20; x++) img.rgba.set([255, 255, 255], (y * 20 + x) * 4);
    const lb = letterbox(img, { x: 10, y: 0, w: 10, h: 10 }, { width: 10, height: 10 });
    expect(Math.min(...lb.data)).toBeCloseTo(1);
  });
});

describe('tile seams', () => {
  const tile = { x: 300, y: 0, w: 400, h: 400 };
  const b = (x0: number, y0: number, x1: number, y1: number) => ({
    x0,
    y0,
    x1,
    y1,
    score: 1,
    cls: 0,
  });
  const photo = { width: 1000, height: 400 };

  it('flags boxes cut by an inner tile edge, not those on the photo edge', () => {
    // left edge (x 300) and right edge (x 700) are inside the photo; the top edge is the photo's
    expect(touchesSeam(b(300, 50, 340, 90), tile, photo)).toBe(true);
    expect(touchesSeam(b(650, 50, 700, 90), tile, photo)).toBe(true);
    expect(touchesSeam(b(400, 0, 440, 40), tile, photo)).toBe(false);
  });
});
