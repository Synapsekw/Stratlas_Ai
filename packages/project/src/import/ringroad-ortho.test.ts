import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromWgs84, toWgs84 } from '@aio/geo';
import { buildOrthoPyramid, readPyramidRegion } from './ringroad-ortho';
import { SRC_TILE, planPyramid, worldPx, worldPxToLonLat } from './ringroad-tiles';
import { PackageWriter } from './writer';

const UTM38 = 32638;
const toLonLat = (e: number, n: number): [number, number] => {
  const [lon, lat] = toWgs84([e, n, 0], UTM38);
  return [lon, lat];
};

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aio-rrortho-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Grey source tiles at `z` around `dot` with a white 3 x 3 px dot centred on it. */
async function sourceTiles(z: number, dot: [number, number]) {
  const [dx, dy] = worldPx(dot[0], dot[1], z);
  const tx0 = Math.floor(dx / SRC_TILE) - 2;
  const ty0 = Math.floor(dy / SRC_TILE) - 2;
  const tiles = new Map<string, Uint8Array>();
  for (let ty = ty0; ty <= ty0 + 4; ty++)
    for (let tx = tx0; tx <= tx0 + 4; tx++) {
      const px = Buffer.alloc(SRC_TILE * SRC_TILE * 4);
      for (let i = 0; i < SRC_TILE * SRC_TILE; i++) px.set([60, 60, 60, 255], i * 4);
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const x = Math.floor(dx) + ox - tx * SRC_TILE;
          const y = Math.floor(dy) + oy - ty * SRC_TILE;
          if (x >= 0 && y >= 0 && x < SRC_TILE && y < SRC_TILE)
            px.set([255, 255, 255, 255], (y * SRC_TILE + x) * 4);
        }
      const webp = await sharp(px, { raw: { width: SRC_TILE, height: SRC_TILE, channels: 4 } })
        .webp({ lossless: true })
        .toBuffer();
      tiles.set(`${z}/${tx}/${ty}`, webp);
    }
  return tiles;
}

describe('ortho pyramid from mercator tiles', () => {
  it('puts a source feature at its UTM position in the local frame tiles', async () => {
    const dot: [number, number] = [47.9941911, 29.3854794];
    const tiles = new Map([...(await sourceTiles(22, dot)), ...(await sourceTiles(21, dot))]);
    const [e, n] = fromWgs84([dot[0], dot[1], 0], UTM38);
    const plan = planPyramid(
      { minE: e - 1.5, minN: n - 1.5, maxE: e + 1.5, maxN: n + 1.5 },
      { finestM: 0.0325, tileSize: 64, levels: 2, finestSrcZoom: 22 },
    );
    const w = new PackageWriter(join(dir, 'out'));
    const r = await buildOrthoPyramid({ tiles, plan, toLonLat, w, quality: 90 });
    expect(r.maxErrPx).toBeLessThan(0.01);
    expect(r.levels.map((l) => l.errPx < 0.01)).toEqual([true, true]);
    expect(r.levels.map((l) => l.tiles)).toEqual([1, 4]);

    // the dot in the finest level: expected tile and pixel from its UTM position
    const fine = plan.levels[1];
    if (!fine) throw new Error('no fine level');
    const gu = (e - plan.left) / fine.metresPerPx;
    const gv = (plan.top - n) / fine.metresPerPx;
    const tx = Math.floor(gu / 64);
    const ty = Math.floor(gv / 64);
    const file = join(dir, 'out', 'rasters/ortho/1', `${tx}_${ty}.webp`);
    const { data, info } = await sharp(readFileSync(file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let best = { v: -1, x: 0, y: 0 };
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const v = data[(y * info.width + x) * 4] ?? 0;
        if (v > best.v) best = { v, x, y };
      }
    expect(best.v).toBeGreaterThan(200);
    // within one pixel (3.25 cm) of where the UTM position says
    expect(Math.abs(best.x + 0.5 - (gu - tx * 64))).toBeLessThan(1.2);
    expect(Math.abs(best.y + 0.5 - (gv - ty * 64))).toBeLessThan(1.2);

    // a window across tile edges reads the same pixel back
    const x0 = Math.round(gu) - 40;
    const y0 = Math.round(gv) - 40;
    const region = await readPyramidRegion(join(dir, 'out'), fine, x0, y0, 80, 80);
    let peak = { v: -1, x: 0, y: 0 };
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 80; x++) {
        const v = region.data[(y * 80 + x) * 4] ?? 0;
        if (v > peak.v) peak = { v, x, y };
      }
    expect(peak.x + x0).toBe(best.x + tx * 64);
    expect(peak.y + y0).toBe(best.y + ty * 64);

    // sub-pixel: the blob's brightness centroid sits where the centre of the source dot pixel
    // (world px floor + 0.5) lands, in pixel-edge coordinates (pixel k spans k to k + 1)
    const [wx, wy] = worldPx(dot[0], dot[1], 22);
    const [clon, clat] = worldPxToLonLat(Math.floor(wx) + 0.5, Math.floor(wy) + 0.5, 22);
    const [ce, cn] = fromWgs84([clon, clat, 0], UTM38);
    const wantU = (ce - plan.left) / fine.metresPerPx - x0;
    const wantV = (plan.top - cn) / fine.metresPerPx - y0;
    let sw = 0;
    let su = 0;
    let sv = 0;
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 80; x++) {
        const v = Math.max(0, (region.data[(y * 80 + x) * 4] ?? 0) - 110);
        sw += v;
        su += v * (x + 0.5);
        sv += v * (y + 0.5);
      }
    expect(Math.abs(su / sw - wantU)).toBeLessThan(0.15);
    expect(Math.abs(sv / sw - wantV)).toBeLessThan(0.15);
  });

  it('skips tiles with no source and keeps tiles of an unchanged source on a re-run', async () => {
    const dot: [number, number] = [47.9941911, 29.3854794];
    const tiles = await sourceTiles(22, dot);
    const [e, n] = fromWgs84([dot[0], dot[1], 0], UTM38);
    const plan = planPyramid(
      { minE: e - 1.5, minN: n - 1.5, maxE: e + 1.5, maxN: n + 1.5 },
      { finestM: 0.0325, tileSize: 64, levels: 2, finestSrcZoom: 22 },
    );
    const first = await buildOrthoPyramid({
      tiles,
      plan,
      toLonLat,
      w: new PackageWriter(join(dir, 'out')),
      stamp: 'v1',
    });
    // no z21 source: level 0 has nothing to draw
    expect(first.levels.map((l) => l.tiles)).toEqual([0, 4]);
    const w2 = new PackageWriter(join(dir, 'out'));
    const again = await buildOrthoPyramid({ tiles, plan, toLonLat, w: w2, stamp: 'v1' });
    expect(again.reused).toBe(true);
    expect(again.levels[1]?.errPx).toBe(first.levels[1]?.errPx);
    // four tiles kept and the unchanged source stamp
    expect(w2.stats).toEqual({ written: 0, skipped: 5 });
  });
});
