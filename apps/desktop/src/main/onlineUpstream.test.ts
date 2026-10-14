/**
 * The one place that names the online map services, and the addresses it builds. No network.
 */
import { ONLINE_SOURCE_IDS } from '@aio/schema';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAPBOX_STYLES,
  ONLINE_HOSTS,
  ONLINE_SATELLITE_HOST,
  ONLINE_SATELLITE_LAYER,
  upstreamTileUrl,
} from './onlineUpstream';

const HOSTS = [...new Set(Object.values(ONLINE_HOSTS).flat())];

describe('the addresses of the services', () => {
  it('Sentinel-2: the one 2016 layer, z/y/x, no key whatever is given', () => {
    const url =
      'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/12/1420/2234.jpg';
    expect(upstreamTileUrl('s2cloudless-2016', 12, 2234, 1420, null)).toBe(url);
    expect(upstreamTileUrl('s2cloudless-2016', 12, 2234, 1420, 'secret')).toBe(url);
    expect(ONLINE_SATELLITE_HOST).toBe('tiles.maps.eox.at');
    // 2016 is the layer without a year; the non-commercial years carry one
    expect(ONLINE_SATELLITE_LAYER).toBe('s2cloudless_3857');
    expect(ONLINE_SATELLITE_LAYER).not.toMatch(/20(1[7-9]|2\d)/);
  });

  it('Esri: the public service without a key, the basemap service with one, z/y/x', () => {
    expect(upstreamTileUrl('esri-world-imagery', 15, 21000, 13000, null)).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/13000/21000',
    );
    expect(upstreamTileUrl('esri-world-imagery', 15, 21000, 13000, 'AAPTabc/+=')).toBe(
      'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/15/13000/21000?token=AAPTabc%2F%2B%3D',
    );
  });

  it('Mapbox Satellite: the raster tiles at 512 px, z/x/y, with the token', () => {
    expect(upstreamTileUrl('mapbox-satellite', 15, 21000, 13000, 'pk.abc')).toBe(
      'https://api.mapbox.com/v4/mapbox.satellite/15/21000/13000@2x.jpg90?access_token=pk.abc',
    );
  });

  it('Mapbox styles: the Static Tiles API at 512 px @2x, with the token', () => {
    expect(MAPBOX_STYLES).toEqual({
      'mapbox-streets': 'streets-v12',
      'mapbox-outdoors': 'outdoors-v12',
      'mapbox-light': 'light-v11',
      'mapbox-dark': 'dark-v11',
      'mapbox-satellite-streets': 'satellite-streets-v12',
    });
    expect(upstreamTileUrl('mapbox-dark', 4, 9, 6, 'pk.abc')).toBe(
      'https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/512/4/9/6@2x?access_token=pk.abc',
    );
  });

  it('never builds a Mapbox address without a key', () => {
    expect(() => upstreamTileUrl('mapbox-streets', 1, 0, 0, null)).toThrow(/needs a key/);
    expect(() => upstreamTileUrl('mapbox-satellite', 1, 0, 0, '')).toThrow(/needs a key/);
  });

  it('every source has its hosts, and every address goes to one of them over https', () => {
    expect(Object.keys(ONLINE_HOSTS).sort()).toEqual([...ONLINE_SOURCE_IDS].sort());
    for (const id of ONLINE_SOURCE_IDS)
      for (const key of [null, 'pk.key-123456']) {
        if (key === null && ONLINE_HOSTS[id].includes('api.mapbox.com')) continue;
        const url = new URL(upstreamTileUrl(id, 3, 4, 2, key));
        expect(url.protocol, id).toBe('https:');
        expect(ONLINE_HOSTS[id], id).toContain(url.host);
        // the key goes in the query only
        if (key) expect(url.pathname, id).not.toContain(key);
      }
  });
});

describe('main owns the network', () => {
  const repo = join(import.meta.dirname, '..', '..', '..', '..');
  // .md too: the guide (docs/guide) is built into the renderer's help
  const SOURCE = /\.(tsx?|mjs|cjs|js|css|html|json|md)$/;
  const TEST = /\.test\.tsx?$/;
  function sources(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap((e) => {
      const p = join(folder, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p);
      return SOURCE.test(e.name) ? [p] : [];
    });
  }
  const names = (file: string) => {
    const text = readFileSync(file, 'utf8');
    return HOSTS.some((h) => text.includes(h)) || text.includes(ONLINE_SATELLITE_LAYER);
  };

  // The credits name products and companies, never a tile service; tests are not built in.
  it('nothing the renderer is built from names a service', () => {
    const folders = [
      join(repo, 'apps', 'desktop', 'src', 'renderer'),
      join(repo, 'apps', 'desktop', 'src', 'preload'),
      join(repo, 'docs', 'guide'),
      ...readdirSync(join(repo, 'packages')).map((name) => join(repo, 'packages', name, 'src')),
    ].filter((f) => existsSync(f));
    expect(folders.length).toBeGreaterThan(10);
    const named = folders
      .flatMap(sources)
      .filter((file) => !TEST.test(file) && names(file))
      .map((file) => relative(repo, file));
    expect(named).toEqual([]);
  });

  it('in main, only this module names them (and tests)', () => {
    const main = join(repo, 'apps', 'desktop', 'src', 'main');
    const named = sources(main)
      .filter((file) => !TEST.test(file) && names(file))
      .map((file) => relative(main, file));
    expect(named).toEqual(['onlineUpstream.ts']);
  });
});
