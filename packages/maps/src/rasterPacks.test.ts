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
  setStreetOverlay,
  syncRasterPacks,
  terrainSource,
  type RasterMap,
  type StreetOverlayMap,
} from './rasterPacks';
import { BASEMAP_SOURCE } from './style';

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

class FakeMap implements RasterMap, StreetOverlayMap {
  sources = new Map<string, unknown>();
  layers: { id: string; type: string; source?: string }[] = [
    { id: 'background', type: 'background' },
    { id: 'water', type: 'fill', source: BASEMAP_SOURCE },
    { id: 'roads', type: 'line', source: BASEMAP_SOURCE },
    { id: 'buildings', type: 'fill', source: BASEMAP_SOURCE },
    { id: 'labels', type: 'symbol', source: BASEMAP_SOURCE },
    { id: 'issues', type: 'symbol', source: 'issues' },
  ];
  /** Every source and layer added or removed, in order. */
  log: string[] = [];
  visibility = new Map<string, string>();
  getStyle() {
    return {
      layers: this.layers as (Pick<LayerSpecification, 'id' | 'type'> & { source?: string })[],
      sources: Object.fromEntries(this.sources),
    };
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  addSource(id: string, s: unknown) {
    this.sources.set(id, s);
    this.log.push(`+${id}`);
  }
  removeSource(id: string) {
    this.sources.delete(id);
    this.log.push(`-${id}`);
  }
  getLayer(id: string) {
    return this.layers.find((l) => l.id === id);
  }
  addLayer(l: LayerSpecification, before?: string) {
    const at = before ? this.layers.findIndex((x) => x.id === before) : this.layers.length;
    const source = 'source' in l && typeof l.source === 'string' ? { source: l.source } : {};
    this.layers.splice(at, 0, { id: l.id, type: l.type, ...source });
    this.log.push(`+${l.id}`);
  }
  removeLayer(id: string) {
    this.layers = this.layers.filter((l) => l.id !== id);
    this.log.push(`-${id}`);
  }
  setLayoutProperty(layer: string, _name: 'visibility', value: 'visible' | 'none') {
    this.visibility.set(layer, value);
  }
  /** The pack layers, bottom to top. */
  packLayers() {
    return this.layers.filter((l) => l.id.startsWith('g7-raster-')).map((l) => l.id);
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
      'buildings',
      'labels',
      'issues',
    ]);
    // idempotent
    applyRasterPacks(map, {
      imagery: [site, world],
      terrain: [dem],
      satellite: true,
      hillshade: true,
    });
    expect(map.layers).toHaveLength(9);
    off();
    expect(map.packLayers()).toEqual([]);
    expect(map.layers).toHaveLength(6);
    expect(map.sources.size).toBe(0);
    expect(insertBefore([])).toBeUndefined();
  });

  describe('switching the map type (syncRasterPacks)', () => {
    const world = pack('world');
    const site = pack('site', { bbox: [51, 28.9, 51.01, 28.94], maxZoom: 17 });
    const dem = pack('dem', { kind: 'terrain', maxZoom: 12 });
    const all = { imagery: [site, world], terrain: [dem] };

    it('adds the packs in order under the streets, as applyRasterPacks does', () => {
      const map = new FakeMap();
      syncRasterPacks(map, { ...all, satellite: true, hillshade: true });
      expect(map.layers.map((l) => l.id)).toEqual([
        'background',
        'water',
        'g7-raster-imagery-world-layer',
        'g7-raster-imagery-site-layer',
        HILLSHADE_LAYER,
        'roads',
        'buildings',
        'labels',
        'issues',
      ]);
      expect([...map.sources.keys()].sort()).toEqual([
        'g7-raster-imagery-site',
        'g7-raster-imagery-world',
        'g7-raster-terrain-dem',
      ]);
    });

    it('touches nothing when nothing changed', () => {
      const map = new FakeMap();
      syncRasterPacks(map, { ...all, satellite: true, hillshade: true });
      map.log = [];
      syncRasterPacks(map, { ...all, satellite: true, hillshade: true });
      expect(map.log).toEqual([]);
    });

    it('Streets takes the imagery away and leaves the hillshade alone, and back', () => {
      const map = new FakeMap();
      syncRasterPacks(map, { ...all, satellite: true, hillshade: true });
      map.log = [];
      syncRasterPacks(map, { ...all, satellite: false, hillshade: true });
      expect(map.packLayers()).toEqual([HILLSHADE_LAYER]);
      expect(map.log.filter((e) => e.includes('terrain') || e.includes('hillshade'))).toEqual([]);
      expect([...map.sources.keys()]).toEqual(['g7-raster-terrain-dem']);
      map.log = [];
      // back to Satellite: the imagery returns under the hillshade, which never left
      syncRasterPacks(map, { ...all, satellite: true, hillshade: true });
      expect(map.packLayers()).toEqual([
        'g7-raster-imagery-world-layer',
        'g7-raster-imagery-site-layer',
        HILLSHADE_LAYER,
      ]);
      expect(map.log.filter((e) => e.includes('terrain') || e.includes('hillshade'))).toEqual([]);
    });

    it('turning the hillshade off and on leaves the imagery alone', () => {
      const map = new FakeMap();
      syncRasterPacks(map, { ...all, satellite: true, hillshade: true });
      map.log = [];
      syncRasterPacks(map, { ...all, satellite: true, hillshade: false });
      expect(map.log).toEqual([`-${HILLSHADE_LAYER}`, '-g7-raster-terrain-dem']);
      syncRasterPacks(map, { ...all, satellite: true, hillshade: true });
      expect(map.log.slice(2)).toEqual(['+g7-raster-terrain-dem', `+${HILLSHADE_LAYER}`]);
    });

    it('one pack instead of all keeps that pack on the map, and a pack added later finds its place', () => {
      const map = new FakeMap();
      syncRasterPacks(map, { ...all, satellite: true, hillshade: true });
      map.log = [];
      syncRasterPacks(map, { imagery: [site], terrain: [dem], satellite: true, hillshade: true });
      expect(map.log).toEqual(['-g7-raster-imagery-world-layer', '-g7-raster-imagery-world']);
      expect(map.packLayers()).toEqual(['g7-raster-imagery-site-layer', HILLSHADE_LAYER]);
      map.log = [];
      syncRasterPacks(map, { ...all, satellite: true, hillshade: true });
      expect(map.log).toEqual(['+g7-raster-imagery-world', '+g7-raster-imagery-world-layer']);
      expect(map.packLayers()).toEqual([
        'g7-raster-imagery-world-layer',
        'g7-raster-imagery-site-layer',
        HILLSHADE_LAYER,
      ]);
    });

    it('moves the hillshade to another terrain pack', () => {
      const map = new FakeMap();
      syncRasterPacks(map, { imagery: [], terrain: [dem], satellite: false, hillshade: true });
      const lidar = pack('lidar', { kind: 'terrain', maxZoom: 15 });
      syncRasterPacks(map, { imagery: [], terrain: [lidar], satellite: false, hillshade: true });
      expect(map.getLayer(HILLSHADE_LAYER)).toMatchObject({ source: 'g7-raster-terrain-lidar' });
      expect([...map.sources.keys()]).toEqual(['g7-raster-terrain-lidar']);
    });

    it('leaves a map without packs as it was', () => {
      const map = new FakeMap();
      syncRasterPacks(map, { imagery: [], terrain: [], satellite: true, hillshade: true });
      expect(map.log).toEqual([]);
    });
  });

  it('Satellite only hides the streets and names over the imagery, not the ground or the project', () => {
    const map = new FakeMap();
    expect(setStreetOverlay(map, false)).toEqual(['roads', 'buildings', 'labels']);
    expect(Object.fromEntries(map.visibility)).toEqual({
      roads: 'none',
      buildings: 'none',
      labels: 'none',
    });
    setStreetOverlay(map, true);
    expect([...map.visibility.values()]).toEqual(['visible', 'visible', 'visible']);
    // a style with nothing over the imagery
    map.layers = [{ id: 'background', type: 'background' }];
    expect(setStreetOverlay(map, false)).toEqual([]);
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
