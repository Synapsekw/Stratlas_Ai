import { HeightTiles, type ProjectManifest, type VolumesFile } from '@aio/schema';
import { decodeTile, TILE } from '@aio/survey';
import { sampleDsm, type DsmGrid } from '@aio/volumetric';
import { describe, expect, it } from 'vitest';
import { kitSurfaceSources, kitSurfaceTiles } from './kitSurface';

/** A kit project without a DSM or cloud layer: two dated surveys with meshes and orthos only. */
const manifest = {
  crs: { epsg: 32639 },
  captures: [
    { id: 'survey-a', label: 'Survey A', date: '2020-12-31' },
    { id: 'survey-b', label: 'Survey B', date: '2021-01-10' },
  ],
  layers: [
    { kind: 'mesh', id: 'terrain-a' },
    { kind: 'raster', id: 'ortho-a', role: 'ortho', format: 'kit-pyramid' },
  ],
} as unknown as ProjectManifest;

const volumes = {
  captures: [
    { epoch: 'e1', captureId: 'survey-a', date: '2020-12-31', label: 'A' },
    { epoch: 'e2', captureId: 'survey-b', date: '2021-01-10', label: 'B' },
  ],
} as unknown as VolumesFile;

const prepared = (capture: string): HeightTiles =>
  ({ id: `x-${capture}`, capture, source: { kind: 'dsm', layer: 'l' } }) as unknown as HeightTiles;

describe('kit DSM surfaces: the sources', () => {
  it('gives each kit survey date without a DSM or cloud one kit-dsm source with its capture', () => {
    expect(kitSurfaceSources(manifest, volumes, [])).toEqual([
      {
        id: 'kit-dsm-e1',
        name: 'Survey A kit DSM',
        source: { kind: 'kit-dsm', epoch: 'e1' },
        capture: 'survey-a',
      },
      {
        id: 'kit-dsm-e2',
        name: 'Survey B kit DSM',
        source: { kind: 'kit-dsm', epoch: 'e2' },
        capture: 'survey-b',
      },
    ]);
  });

  it('leaves out dates already prepared, dates not asked for and dates with their own DSM', () => {
    expect(
      kitSurfaceSources(manifest, volumes, [prepared('survey-a')]).map((s) => s.capture),
    ).toEqual(['survey-b']);
    expect(kitSurfaceSources(manifest, volumes, [], ['survey-a']).map((s) => s.capture)).toEqual([
      'survey-a',
    ]);
    const withDsm = {
      ...manifest,
      layers: [
        ...manifest.layers,
        { kind: 'raster', id: 'dsm-b', role: 'dsm', capture: 'survey-b' },
      ],
    } as unknown as ProjectManifest;
    expect(kitSurfaceSources(withDsm, volumes, []).map((s) => s.capture)).toEqual(['survey-a']);
  });

  it('gives nothing without kit volumes, and skips an epoch whose survey date is not in the project', () => {
    expect(kitSurfaceSources(manifest, null, [])).toEqual([]);
    const stray = {
      captures: [
        ...volumes.captures,
        { epoch: 'e3', captureId: 'gone', date: '2021-02-01', label: 'C' },
      ],
    } as unknown as VolumesFile;
    expect(kitSurfaceSources(manifest, stray, []).map((s) => s.capture)).toEqual([
      'survey-a',
      'survey-b',
    ]);
  });
});

/** A synthetic kit grid over two tiles each way, with a hole and a sloping surface. */
function grid(): DsmGrid {
  const w = 300;
  const h = 270;
  const z = new Int16Array(w * h);
  const valid = new Uint8Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      z[k] = 3 * i - 2 * j + ((i * 7 + j * 13) % 11);
      valid[k] = i > 20 && i < 30 && j > 40 && j < 50 ? 0 : 1;
    }
  return { epoch: 'e1', w, h, res: 0.4, x0: 212379, y1: 3201883, zoff: 50, z, valid };
}

describe('kit DSM surfaces: the tiles', () => {
  it('writes tiles whose heights are the kit DSM heights at the same places', async () => {
    const g = grid();
    const spec = {
      id: 'kit-dsm-e1',
      name: 'A kit DSM',
      source: { kind: 'kit-dsm' as const, epoch: 'e1' },
      capture: 'survey-a',
    };
    const out = await kitSurfaceTiles(g, spec, { crs: { epsg: 32639 }, sha256: 'a'.repeat(64) });
    expect(HeightTiles.safeParse(out.tiles).success).toBe(true);
    const t = out.tiles;
    expect(t).toMatchObject({ cellM: 0.4, cols: 2, rows: 2, capture: 'survey-a', originE: 212379 });
    expect(t.originN).toBeCloseTo(3201883 - 270 * 0.4, 6);
    expect(t.levels).toBe(2);
    expect(new Set(out.files.map((f) => f.path))).toEqual(
      new Set(['0/0_0.bin', '0/1_0.bin', '0/0_1.bin', '0/1_1.bin', '1/0_0.bin']),
    );
    const level0 = new Map(
      await Promise.all(
        out.files
          .filter((f) => f.path.startsWith('0/'))
          .map(async (f) => [f.path.slice(2, -4), await decodeTile(f.data)] as const),
      ),
    );
    const heightAt = (e: number, n: number): number | null => {
      const i = Math.floor((e - t.originE) / t.cellM);
      const j = Math.floor((n - t.originN) / t.cellM);
      const tile = level0.get(`${Math.floor(i / TILE)}_${Math.floor(j / TILE)}`);
      const k = (j % TILE) * TILE + (i % TILE);
      if (!tile || !((tile.mask[k >> 3] ?? 0) & (1 << (k & 7)))) return null;
      return tile.base + (tile.rel[k] ?? Number.NaN);
    };
    // cell centres across both tile rows and columns: the same height as the kit reads
    for (const [i, j] of [
      [0, 0],
      [5, 3],
      [150, 100],
      [260, 20],
      [299, 269],
      [100, 260],
      [280, 200],
    ] as const) {
      const e = g.x0 + (i + 0.5) * g.res;
      const n = g.y1 - (j + 0.5) * g.res;
      const kit = (g.z[j * g.w + i] ?? 0) / 100 + g.zoff;
      expect(heightAt(e, n)).toBeCloseTo(kit, 4);
      const s = sampleDsm(g, e, n);
      if (s !== null) expect(heightAt(e, n)).toBeCloseTo(s, 4);
    }
    // the hole stays empty
    expect(heightAt(g.x0 + 25.5 * g.res, g.y1 - 45.5 * g.res)).toBeNull();
    expect(t.bounds[0]).toBeCloseTo(g.x0, 6);
    expect(t.bounds[4]).toBeCloseTo(g.y1, 6);
    expect(t.source).toEqual({ kind: 'kit-dsm', epoch: 'e1' });
    expect(t.sourceSha256).toBe('a'.repeat(64));
  });
});
