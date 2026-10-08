/**
 * Interactive speed (M11 plan, "Quality targets"): all comparisons of a 1 ha polygon at 5 cm
 * (4 M cells) under 300 ms on the reference laptop. Measured here on prepared tiles already in
 * the tile cache (what a vertex drag sees after the first computation); CI machines vary, so the
 * test allows a generous margin and logs the time it measured.
 */
import type { ComparisonItem, SurfaceRef } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { compareItems, type Resolve, type ResolvedSurface } from './compare';
import { buildTile, deflate, TILE, TileCache, TileSurface } from './tiles';

const CELL = 0.05;
const TILES = 9; // 115.2 m square of 5 cm cells
const E0 = 302000;
const N0 = 2574000;

async function surface(name: string, fn: (x: number, y: number) => number, cache: TileCache) {
  const files = new Map<string, Uint8Array>();
  const heights = new Float64Array(TILE * TILE);
  for (let r = 0; r < TILES; r++)
    for (let c = 0; c < TILES; c++) {
      for (let j = 0; j < TILE; j++)
        for (let i = 0; i < TILE; i++)
          heights[j * TILE + i] = fn((c * TILE + i + 0.5) * CELL, (r * TILE + j + 0.5) * CELL);
      files.set(`${c}_${r}`, await deflate(buildTile(heights)));
    }
  const meta = {
    originE: E0,
    originN: N0,
    cellM: CELL,
    cols: TILES,
    rows: TILES,
    tiles: [...files.keys()],
  };
  const grid = new TileSurface(
    name,
    meta,
    (c, r) => Promise.resolve(files.get(`${c}_${r}`) ?? null),
    cache,
  );
  return { kind: 'grid', name, fingerprint: `fp-${name}`, grid } satisfies ResolvedSurface;
}

describe('interactive speed', () => {
  it('computes every comparison of a 1 ha polygon at 5 cm quickly', async () => {
    const cache = new TileCache(512);
    const pile = (x: number, y: number) =>
      100 + 0.01 * x + Math.max(0, 6 - Math.sqrt((x - 57) ** 2 + (y - 57) ** 2) / 6);
    const current = await surface('current', pile, cache);
    const previous = await surface('previous', (x) => 100 + 0.01 * x, cache);
    const resolve: Resolve = (ref: SurfaceRef) =>
      Promise.resolve(ref.kind === 'previous' ? previous : current);
    // a 1 ha polygon (an irregular octagon of 10,000 m2 or so)
    const ring: [number, number][] = [];
    for (let k = 0; k < 8; k++) {
      const a = (2 * Math.PI * k) / 8 + 0.2;
      const rad = 59.5 + (k % 2 ? 3 : -3);
      ring.push([E0 + 57 + rad * Math.cos(a), N0 + 57 + rad * Math.sin(a)]);
    }
    const cur: SurfaceRef = { kind: 'current' };
    const items: ComparisonItem[] = [
      { id: 'prev', from: { kind: 'previous' }, to: cur, useDeadband: false },
      { id: 'smart', from: { kind: 'smart' }, to: cur, useDeadband: false },
      { id: 'plane', from: { kind: 'fit-plane' }, to: cur, useDeadband: false },
      { id: 'mean', from: { kind: 'perimeter-mean' }, to: cur, useDeadband: false },
      {
        id: 'low',
        from: { kind: 'reference', mode: 'perimeter-min' },
        to: cur,
        useDeadband: true,
        deadbandM: 0.05,
      },
    ];
    const cold0 = performance.now();
    const first = await compareItems(ring, items, resolve);
    const cold = performance.now() - cold0;
    const t0 = performance.now();
    const again = await compareItems(ring, items, resolve);
    const warm = performance.now() - t0;
    expect(again.map((r) => r.fillM3)).toEqual(first.map((r) => r.fillM3));
    expect(first[0]?.areaM2).toBeGreaterThan(9000);
    expect(first[0]?.areaM2).toBeLessThan(11000);
    const cells = (first[0]?.areaM2 ?? 0) / (CELL * CELL);
    // eslint-disable-next-line no-console -- the measured time, for the stream report
    console.info(
      `survey engine: ${items.length} comparisons of ${Math.round(first[0]?.areaM2 ?? 0)} m2 ` +
        `(${(cells / 1e6).toFixed(1)} M cells): ${warm.toFixed(0)} ms warm, ${cold.toFixed(0)} ms cold`,
    );
    // 300 ms on the reference laptop; CI runners are slower and shared
    expect(warm).toBeLessThan(3000);
  }, 120_000);
});
