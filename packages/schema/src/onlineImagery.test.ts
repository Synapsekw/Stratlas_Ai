import { describe, expect, it } from 'vitest';
import {
  BaseMapId,
  DEFAULT_ONLINE_SOURCE,
  isOnlineBase,
  MapKeysStatus,
  ONLINE_SATELLITE,
  ONLINE_SOURCE_IDS,
  ONLINE_SOURCES,
  onlineAvailability,
  onlineSource,
  OnlineSettings,
  onlineState,
  onlineTileTemplate,
  onlineTileUrl,
} from './onlineImagery';

describe('the online source catalog', () => {
  it('lists every id once, in the order of the ids', () => {
    expect(ONLINE_SOURCES.map((s) => s.id)).toEqual([...ONLINE_SOURCE_IDS]);
  });

  it('gives every source an attribution, a licence, a key policy and a zoom range', () => {
    for (const s of ONLINE_SOURCES) {
      expect(s.attribution.trim(), s.id).not.toBe('');
      expect(s.licence.trim(), s.id).not.toBe('');
      expect(['none', 'optional', 'required'], s.id).toContain(s.keyPolicy);
      // a source with a key policy names its vault account, and only then
      expect(s.keyPolicy === 'none', s.id).toBe(s.keyProvider === undefined);
      expect(s.minZoom, s.id).toBe(0);
      expect(s.maxZoom, s.id).toBeGreaterThan(s.minZoom);
      expect(s.maxZoom, s.id).toBeLessThanOrEqual(22);
      expect([256, 512], s.id).toContain(s.tileSize);
      expect(s.imagePx, s.id).toBeGreaterThanOrEqual(s.tileSize);
      expect(s.formats.length, s.id).toBeGreaterThan(0);
    }
  });

  it('keeps tiles on disk for Sentinel-2 only: the other terms forbid offline storage', () => {
    expect(ONLINE_SOURCES.filter((s) => s.diskCache).map((s) => s.id)).toEqual([
      's2cloudless-2016',
    ]);
  });

  it('names no tile server: the renderer reads this catalog', () => {
    const text = JSON.stringify(ONLINE_SOURCES);
    for (const host of [
      // joined, so that this file does not name the service itself (onlineTiles.test.ts scans it)
      ['tiles.maps', 'eox.at'].join('.'),
      'arcgisonline.com',
      'arcgis.com',
      'mapbox.com',
      'http://',
    ])
      expect(text).not.toContain(host);
  });

  it('keeps the Sentinel-2 entry in step with the 0.11 description', () => {
    const s2 = onlineSource('s2cloudless-2016');
    expect(s2?.attribution).toBe(ONLINE_SATELLITE.attribution);
    expect(s2?.maxZoom).toBe(ONLINE_SATELLITE.maxZoom);
    expect(s2?.keyPolicy).toBe('none');
  });

  it('marks which pictures carry their own street names', () => {
    const labelled = ONLINE_SOURCES.filter((s) => s.labels).map((s) => s.id);
    expect(labelled).toEqual([
      'mapbox-streets',
      'mapbox-outdoors',
      'mapbox-light',
      'mapbox-dark',
      'mapbox-satellite-streets',
    ]);
    expect(onlineSource('mapbox-satellite-streets')?.imagery).toBe(true);
    expect(onlineSource('mapbox-light')?.imagery).toBe(false);
  });

  it('builds the app own tile addresses', () => {
    expect(onlineTileTemplate('esri-world-imagery')).toBe(
      'aio://online/esri-world-imagery/{z}/{x}/{y}',
    );
    expect(onlineTileUrl('mapbox-streets', 3, 4, 2)).toBe('aio://online/mapbox-streets/3/4/2');
    expect(onlineSource('nope')).toBeUndefined();
  });

  it('takes streets, natural-earth and every source id as a base map, nothing else', () => {
    for (const id of ['streets', 'natural-earth', ...ONLINE_SOURCE_IDS])
      expect(BaseMapId.safeParse(id).success, id).toBe(true);
    expect(BaseMapId.safeParse('satellite').success).toBe(false);
    expect(isOnlineBase('streets')).toBe(false);
    expect(isOnlineBase('natural-earth')).toBe(false);
    expect(isOnlineBase('mapbox-dark')).toBe(true);
    expect(MapKeysStatus.parse({ esri: false, mapbox: true })).toEqual({
      esri: false,
      mapbox: true,
    });
  });
});

describe('online settings (online.json, still aio.online-settings/1)', () => {
  it('keeps Sentinel-2 for a workstation that had it on, and starts others on Esri', () => {
    expect(DEFAULT_ONLINE_SOURCE).toBe('esri-world-imagery');
    expect(onlineState({ satellite: true })).toEqual({ enabled: true, source: 's2cloudless-2016' });
    expect(onlineState({ satellite: false })).toEqual({
      enabled: false,
      source: 'esri-world-imagery',
    });
    expect(onlineState({})).toEqual({ enabled: false, source: 'esri-world-imagery' });
    expect(onlineState({ satellite: true, source: 'mapbox-satellite' })).toEqual({
      enabled: true,
      source: 'mapbox-satellite',
    });
  });

  it('reads a source a later build adds as absent', () => {
    const r = OnlineSettings.parse({
      schema: 'aio.online-settings/1',
      satellite: true,
      source: 'later-source',
    });
    expect(r.source).toBeUndefined();
    expect(onlineState(r)).toEqual({ enabled: true, source: 's2cloudless-2016' });
  });

  it('says per source what main may do', () => {
    const s2 = { diskCache: true };
    const esri = { diskCache: false };
    expect(onlineAvailability(esri, { enabled: false, offlineOnly: false })).toBe('off');
    expect(onlineAvailability(esri, { enabled: true, offlineOnly: false })).toBe('online');
    expect(onlineAvailability(esri, { enabled: true, offlineOnly: true })).toBe('offline');
    expect(onlineAvailability(s2, { enabled: true, offlineOnly: true })).toBe('cached');
    expect(onlineAvailability(s2, { enabled: false, offlineOnly: true })).toBe('off');
  });
});
