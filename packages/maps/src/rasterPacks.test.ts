import type { LayerSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import {
  applyRasterPacks,
  createRasterProtocol,
  HILLSHADE_LAYER,
  imagerySource,
  insertBefore,
  rasterTileUrl,
  satelliteLayers,
  terrainSource,
  type RasterMap,
} from './rasterPacks';

const pack = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'imagery' as const,
  label: id,
  bbox: [-180, -85, 180, 85] as [number, number, number, number],
  minZoom: 0,
  maxZoom: 9,
  tileSize: 256 as const,
  attribution: `© ${id}`,
  ...over,
});

class FakeMap implements RasterMap {
  sources = new Map<string, unknown>();
  layers: { id: string; type: string }[] = [
    { id: 'background', type: 'background' },
    { id: 'water', type: 'fill' },
    { id: 'roads', type: 'line' },
    { id: 'labels', type: 'symbol' },
  ];
  getStyle() {
    return { layers: this.layers as Pick<LayerSpecification, 'id' | 'type'>[] };
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  addSource(id: string, s: unknown) {
    this.sources.set(id, s);
  }
  removeSource(id: string) {
    this.sources.delete(id);
  }
  getLayer(id: string) {
    return this.layers.find((l) => l.id === id);
  }
  addLayer(l: LayerSpecification, before?: string) {
    const at = before ? this.layers.findIndex((x) => x.id === before) : this.layers.length;
    this.layers.splice(at, 0, { id: l.id, type: l.type });
  }
  removeLayer(id: string) {
    this.layers = this.layers.filter((l) => l.id !== id);
  }
}

describe('imagery and terrain packs on the map (Satellite)', () => {
  it('makes one source per pack with its bounds, zooms and attribution', () => {
    const p = pack('site', { bbox: [51, 28.9, 51.01, 28.94], minZoom: 0, maxZoom: 17 });
    expect(rasterTileUrl(p)).toBe('aioraster://imagery/site/{z}/{x}/{y}');
    expect(imagerySource(p)).toEqual({
      type: 'raster',
      tiles: ['aioraster://imagery/site/{z}/{x}/{y}'],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 17,
      bounds: [51, 28.9, 51.01, 28.94],
      attribution: '© site',
    });
    const dem = terrainSource(pack('dem', { kind: 'terrain', maxZoom: 12 }));
    expect(dem.type).toBe('raster-dem');
    expect(dem.encoding).toBe('terrarium');
    expect(dem.bounds).toEqual([-180, -85, 180, 85]);
  });

  it('stacks imagery coarse to detailed under the streets, hillshade above, and removes it all', () => {
    const map = new FakeMap();
    const world = pack('world');
    const site = pack('site', { bbox: [51, 28.9, 51.01, 28.94], maxZoom: 17 });
    const dem = pack('dem', { kind: 'terrain', maxZoom: 12 });
    expect(satelliteLayers([site, world]).map((l) => l.source)).toEqual([
      'g7-raster-imagery-world',
      'g7-raster-imagery-site',
    ]);
    const off = applyRasterPacks(map, {
      imagery: [site, world],
      terrain: [dem],
      satellite: true,
      hillshade: true,
    });
    expect(map.layers.map((l) => l.id)).toEqual([
      'background',
      'water',
      'g7-raster-imagery-world-layer',
      'g7-raster-imagery-site-layer',
      HILLSHADE_LAYER,
      'roads',
      'labels',
    ]);
    // idempotent
    applyRasterPacks(map, {
      imagery: [site, world],
      terrain: [dem],
      satellite: true,
      hillshade: true,
    });
    expect(map.layers).toHaveLength(7);
    off();
    expect(map.layers.map((l) => l.id)).toEqual(['background', 'water', 'roads', 'labels']);
    expect(map.sources.size).toBe(0);
    expect(insertBefore([])).toBeUndefined();
  });

  it('serves pack tiles, a transparent tile where a pack has none, and refuses other URLs', async () => {
    const opened: string[] = [];
    const handler = createRasterProtocol((kind, id) => {
      opened.push(`${kind}/${id}`);
      return {
        getZxy: (z) =>
          Promise.resolve(z === 5 ? { data: new Uint8Array([1, 2, 3]).buffer } : undefined),
      };
    });
    const abort = new AbortController();
    const hit = await handler({ url: 'aioraster://imagery/site/5/1/2' }, abort);
    expect(new Uint8Array(hit.data)).toEqual(new Uint8Array([1, 2, 3]));
    const miss = await handler({ url: 'aioraster://imagery/site/6/1/2' }, abort);
    expect(new Uint8Array(miss.data).slice(1, 4)).toEqual(new TextEncoder().encode('PNG'));
    await expect(handler({ url: 'aioraster://terrain/dem/6/1/2' }, abort)).rejects.toThrow();
    await expect(handler({ url: 'aioraster://imagery/../x/1/1/1' }, abort)).rejects.toThrow();
    expect(opened).toEqual(['imagery/site', 'terrain/dem']);
  });
});
