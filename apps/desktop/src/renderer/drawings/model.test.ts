import { describe, expect, it } from 'vitest';
import {
  PAGE_BYTES,
  PAGE_CAP,
  cornersFromPairs,
  defaultPages,
  drawWithinCap,
  fitWithin,
  pageSizePx,
  parsePages,
  sideBySide,
  svgSize,
  type PlacePair,
} from './model';

describe('which pages of a PDF become drawings', () => {
  it('reads single pages and ranges, in page order, once each', () => {
    expect(parsePages('1-3, 7', 10)).toEqual({ pages: [1, 2, 3, 7] });
    expect(parsePages(' 5 ,2;2 ', 10)).toEqual({ pages: [2, 5] });
    expect(parsePages('4-2', 10)).toEqual({ pages: [2, 3, 4] });
  });

  it('says what is wrong instead of guessing', () => {
    expect(parsePages('', 10)).toEqual({ error: 'Type the pages to import, for example 1-3, 7.' });
    expect(parsePages('two', 10)).toEqual({
      error: 'Type the pages to import, for example 1-3, 7.',
    });
    expect(parsePages('0-2', 10)).toEqual({ error: 'This file has pages 1 to 10.' });
    expect(parsePages('11', 10)).toEqual({ error: 'This file has pages 1 to 10.' });
  });

  it('takes at most the cap in one import', () => {
    expect(parsePages('1-30', 40)).toEqual({
      error: `At most ${String(PAGE_CAP)} pages in one import; 30 are listed.`,
    });
  });

  it('proposes the first page only: every page is a drawing that stays', () => {
    expect(defaultPages()).toBe('1');
    expect(parsePages(defaultPages(), 85)).toEqual({ pages: [1] });
  });
});

describe('the size a page or a picture is drawn at', () => {
  const long = (w: number, h: number) => {
    const s = pageSizePx(w, h);
    return Math.max(s.width, s.height);
  };

  it('keeps line work legible: 220 dpi, at least 4096 and at most 8192 pixels', () => {
    // A1 landscape, 2384 x 1684 points: 220 dpi is inside the limits
    expect(long(2384, 1684)).toBe(Math.round((2384 / 72) * 220));
    // A4: lifted to 4096
    expect(long(842, 595)).toBe(4096);
    // A0: held at 8192
    expect(long(3370, 2384)).toBe(8192);
  });

  it('never draws a small page above 600 dpi', () => {
    expect(long(200, 100)).toBe(Math.round((200 / 72) * 600));
  });

  it('keeps the page shape', () => {
    const s = pageSizePx(842, 595);
    expect(s.width / s.height).toBeCloseTo(842 / 595, 2);
    expect(s.scale).toBeCloseTo(4096 / 842, 5);
  });

  it('scales a picture down to the limit and leaves a smaller one alone', () => {
    expect(fitWithin(16384, 4096, 8192)).toEqual({ width: 8192, height: 2048 });
    expect(fitWithin(1200, 800, 8192)).toEqual({ width: 1200, height: 800 });
  });
});

describe('the size an SVG asks for', () => {
  it('reads its width and height, else its view box', () => {
    expect(svgSize('<svg width="800" height="600" viewBox="0 0 80 60">')).toEqual({
      width: 800,
      height: 600,
    });
    expect(svgSize('<?xml version="1.0"?><svg viewBox="0 0 420 297" xmlns="x">')).toEqual({
      width: 420,
      height: 297,
    });
    // a size in other units is not a pixel size: the view box decides
    expect(svgSize('<svg width="210mm" height="297mm" viewBox="0 0 210 297">')).toEqual({
      width: 210,
      height: 297,
    });
    expect(svgSize('<svg xmlns="x">')).toBeNull();
    expect(svgSize('not an svg')).toBeNull();
  });
});

describe('placing a drawing by point pairs', () => {
  const size = { width: 1000, height: 500 };
  // the truth: 0.2 m per pixel, turned 90 degrees (the top of the sheet points east), the
  // top-left corner at x 40, z -10, on a base 3 m up
  const truth = (px: number, py: number): [number, number, number] => [
    40 - 0.2 * py,
    3,
    -10 + 0.2 * px,
  ];
  const pair = (px: number, py: number): PlacePair => ({ px: [px, py], local: truth(px, py) });

  it('needs two pairs at different drawing points', () => {
    expect(cornersFromPairs([pair(0, 0)], size)).toEqual({
      error: 'Give at least two point pairs.',
    });
    const same = cornersFromPairs([pair(10, 10), pair(10, 10)], size);
    expect('error' in same && same.error).toContain('too close together');
  });

  it('finds the corners from two pairs', () => {
    const r = cornersFromPairs([pair(100, 100), pair(900, 400)], size);
    if ('error' in r) throw new Error(r.error);
    const near = (a: readonly number[], b: readonly number[]) => {
      a.forEach((v, i) => {
        expect(v).toBeCloseTo(b[i] ?? 0, 6);
      });
    };
    near(r.corners.tl, truth(0, 0));
    near(r.corners.tr, truth(1000, 0));
    near(r.corners.bl, truth(0, 500));
    expect(r.metresPerPx).toBeCloseTo(0.2, 6);
    expect(r.rms).toBeCloseTo(0, 6);
  });

  it('refuses pairs that put two drawing points on one spot of the site', () => {
    const spot = truth(100, 100);
    const r = cornersFromPairs(
      [
        { px: [100, 100], local: spot },
        { px: [900, 400], local: [spot[0], spot[1], spot[2]] },
      ],
      size,
    );
    expect(r).toEqual({
      error: 'The site points are too close together. Give spots further apart.',
    });
    // a few centimetres apart is still one spot for a sheet hundreds of pixels wide
    const near = cornersFromPairs(
      [
        { px: [100, 100], local: spot },
        { px: [900, 400], local: [spot[0] + 0.0001, spot[1], spot[2]] },
      ],
      size,
    );
    expect('error' in near).toBe(true);
  });

  it('reports how far each pair is off when they disagree', () => {
    const off = pair(500, 250);
    off.local = [off.local[0] + 1, off.local[1], off.local[2]];
    const r = cornersFromPairs([pair(100, 100), pair(900, 400), pair(100, 400), off], size);
    if ('error' in r) throw new Error(r.error);
    expect(r.rms).toBeGreaterThan(0.2);
    expect(r.residuals[3]).toBeGreaterThan(r.residuals[0] ?? 0);
  });

  it('a pair from the map fixes the plan only: the base comes from the pairs with a height', () => {
    const flat: PlacePair = { px: [900, 400], local: [truth(900, 400)[0], 0, truth(900, 400)[2]] };
    const r = cornersFromPairs([pair(100, 100), { ...flat, horizontalOnly: true }], size);
    if ('error' in r) throw new Error(r.error);
    expect(r.corners.tl[1]).toBeCloseTo(3, 6);
  });
});

describe('open a drawing side by side', () => {
  it('puts the drawing on the right and keeps the view the person was in on the left', () => {
    expect(sideBySide({ left: '3d', right: 'map' }, 'map', 'sheet-a')).toEqual({
      left: 'map',
      right: 'raster',
      raster: 'sheet-a',
    });
    expect(sideBySide({ left: 'video', right: 'photo', report: 'r.pdf' }, '3d', 'sheet-a')).toEqual(
      { left: '3d', right: 'raster', raster: 'sheet-a', report: 'r.pdf' },
    );
  });

  it('in the split already, only the right side changes', () => {
    expect(sideBySide({ left: 'video', right: 'map' }, 'split', 'sheet-a')).toEqual({
      left: 'video',
      right: 'raster',
      raster: 'sheet-a',
    });
    // the drawing pane was on the left: it moves to the right, the 3D view takes its place
    expect(sideBySide({ left: 'raster', right: 'map' }, 'split', 'sheet-a')).toEqual({
      left: '3d',
      right: 'raster',
      raster: 'sheet-a',
    });
  });
});

describe('a page too heavy to hand over is drawn again, smaller', () => {
  const bytes = (n: number) => new Uint8Array(n);

  it('keeps the first drawing when it fits', async () => {
    const asked: number[] = [];
    const png = await drawWithinCap((shrink) => {
      asked.push(shrink);
      return Promise.resolve(bytes(10));
    }, 100);
    expect(png.byteLength).toBe(10);
    expect(asked).toEqual([1]);
  });

  it('steps the scale down until the page fits', async () => {
    const asked: number[] = [];
    const png = await drawWithinCap((shrink) => {
      asked.push(shrink);
      return Promise.resolve(bytes(Math.round(400 * shrink * shrink)));
    }, 100);
    expect(asked).toEqual([1, 0.7, 0.5]);
    expect(png.byteLength).toBe(100);
  });

  it('says so in plain words when even the smallest drawing is too heavy', async () => {
    const asked: number[] = [];
    await expect(
      drawWithinCap((shrink) => {
        asked.push(shrink);
        return Promise.resolve(bytes(1000));
      }, 100),
    ).rejects.toThrow('too detailed to bring in, even at a third of its size');
    expect(asked).toEqual([1, 0.7, 0.5, 0.35]);
  });

  it('the cap is the one the page channel takes', () => {
    expect(PAGE_BYTES).toBe(64 * 1024 * 1024);
  });
});
