import { describe, expect, it } from 'vitest';
import { siteFrame, type V3 } from './frame';
import { createRasterTileSource, type RasterPack } from './packs';
import { buildSurroundings, type Pixels } from './surroundings';

const manifest = { crs: { epsg: 32639 }, origin: [500_000, 3_200_000, 40] as V3 };
const frame = siteFrame(manifest);
if (!frame) throw new Error('no frame');

const terrain: RasterPack = {
  id: 'dem',
  kind: 'terrain',
  label: 'DEM',
  bbox: [50, 28, 52, 30],
  minZoom: 0,
  maxZoom: 12,
  attribution: 'CC0 test fixture',
  licence: 'CC0-1.0',
};

/** Every terrain tile is flat at 52.5 m (Terrarium). */
function flatTile(h: number): Pixels {
  const n = Math.round((h + 32768) * 256);
  const data = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < 256 * 256; i++) data.set([n >> 16, (n >> 8) & 255, n & 255, 255], i * 4);
  return { width: 256, height: 256, data };
}

describe('terrain and imagery around the site', () => {
  it('builds a landscape mesh in the local frame from a terrain pack, under the site', async () => {
    const source = createRasterTileSource('terrain', [terrain], () => ({
      getZxy: () => Promise.resolve({ data: new ArrayBuffer(4) }),
    }));
    const mesh = await buildSurroundings({
      frame,
      terrain: source,
      imagery: null,
      radiusM: 1000,
      grid: 9,
      decode: () => Promise.resolve(flatTile(52.5)),
    });
    expect(mesh).not.toBeNull();
    if (!mesh) return;
    const pos = mesh.geometry.getAttribute('position');
    expect(pos.count).toBe(81);
    for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBeCloseTo(52.5 - 40 - 0.3, 3);
    expect(pos.getX(0)).toBe(-1000);
    expect(pos.getZ(80)).toBe(1000);
    expect(mesh.userData.credits).toEqual(['CC0 test fixture']);
    // not pickable: clicks go to the ground
    const hits: unknown[] = [];
    mesh.raycast.call(mesh, {} as never, hits as never);
    expect(hits).toEqual([]);
  });

  it('draws nothing without packs or tiles', async () => {
    expect(await buildSurroundings({ frame, terrain: null, imagery: null })).toBeNull();
    const empty = createRasterTileSource('terrain', [terrain], () => ({
      getZxy: () => Promise.resolve(undefined),
    }));
    expect(
      await buildSurroundings({ frame, terrain: empty, imagery: null, radiusM: 500, grid: 3 }),
    ).toBeNull();
  });
});
