import type { RasterPackInfo } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  basemapModel,
  basemapPatch,
  coveringPacks,
  groundModel,
  onlineRow,
  siteLonLat,
  type BasemapPrefs,
} from './basemap';

const pack = (
  id: string,
  bbox: [number, number, number, number],
  over: Partial<RasterPackInfo> = {},
): RasterPackInfo =>
  ({
    id,
    kind: 'imagery',
    label: id,
    bbox,
    minZoom: 0,
    maxZoom: 10,
    tileSize: 256,
    attribution: 'Test',
    licence: 'CC0-1.0',
    sizeBytes: 1,
    ...over,
  }) as RasterPackInfo;

const WORLD: [number, number, number, number] = [-180, -85, 180, 85];
const SITE = [51, 29] as const;
const world = pack('world', WORLD, { maxZoom: 3 });
const here = pack('here', [50.9, 28.9, 51.1, 29.1], { maxZoom: 16 });
const elsewhere = pack('elsewhere', [10, 10, 11, 11], { maxZoom: 16 });
const dem = pack('dem', [50, 28, 52, 30], { kind: 'terrain', maxZoom: 12 });
const demFar = pack('dem-far', [10, 10, 11, 11], { kind: 'terrain', maxZoom: 14 });

const prefs = (over: Partial<BasemapPrefs> = {}): BasemapPrefs => ({
  satellite: true,
  hillshade: true,
  streets: true,
  imageryPack: null,
  onlineSatellite: false,
  ...over,
});

describe('where the site is', () => {
  it('is the origin of a project in UTM, and unknown in a local grid', () => {
    const at = siteLonLat({ crs: { epsg: 32639 }, origin: [500000, 3200000, 0] });
    expect(at?.[0]).toBeCloseTo(51, 5);
    expect(at?.[1]).toBeCloseTo(28.93, 1);
    expect(siteLonLat({ crs: { wkt: 'LOCAL_CS["Grid"]' }, origin: [0, 0, 0] })).toBeNull();
    expect(siteLonLat(null)).toBeNull();
  });

  it('keeps the packs that cover it, most detailed first', () => {
    expect(coveringPacks([world, elsewhere, here], SITE).map((p) => p.id)).toEqual([
      'here',
      'world',
    ]);
    // a site that cannot be placed cannot be checked: every pack counts
    expect(coveringPacks([world, elsewhere, here], null)).toHaveLength(3);
  });
});

describe('the basemap of a site', () => {
  it('is the streets when no imagery pack covers the site, whatever was chosen', () => {
    const m = basemapModel(prefs(), [elsewhere], [], SITE);
    expect(m.choice).toBe('streets');
    expect(m.satellite).toBe(false);
    expect(m.hillshade).toBe(false);
    expect(m.draw).toEqual({
      imagery: [],
      terrain: [],
      satellite: false,
      hillshade: false,
      streets: true,
      online: false,
    });
  });

  it('Satellite draws every installed pack, so the map stays covered away from the site', () => {
    const m = basemapModel(prefs(), [world, elsewhere, here], [dem], SITE);
    expect(m.choice).toBe('satellite');
    expect(m.packs.map((p) => p.id)).toEqual(['here', 'world']);
    expect(m.pack).toBeNull();
    expect(m.draw.imagery.map((p) => p.id)).toEqual(['world', 'elsewhere', 'here']);
    expect(m.draw.streets).toBe(true);
    expect(m.hillshadeOn).toBe(true);
  });

  it('Satellite only hides the streets; Streets shows them again', () => {
    const only = basemapModel(prefs({ streets: false }), [world], [], SITE);
    expect(only.choice).toBe('imagery');
    expect(only.draw).toMatchObject({ satellite: true, streets: false });
    // the streets are never hidden without imagery under them
    const off = basemapModel(prefs({ streets: false, satellite: false }), [world], [], SITE);
    expect(off.choice).toBe('streets');
    expect(off.draw).toMatchObject({ satellite: false, streets: true, imagery: [] });
    const none = basemapModel(prefs({ streets: false }), [], [], SITE);
    expect(none.draw.streets).toBe(true);
  });

  it('draws the one pack chosen, and the best available when that pack is gone', () => {
    const one = basemapModel(prefs({ imageryPack: 'here' }), [world, here], [], SITE);
    expect(one.pack).toBe('here');
    expect(one.draw.imagery.map((p) => p.id)).toEqual(['here']);
    const gone = basemapModel(prefs({ imageryPack: 'removed' }), [world, here], [], SITE);
    expect(gone.pack).toBeNull();
    expect(gone.draw.imagery).toHaveLength(2);
    // a pack that does not cover this site is not a choice for it
    const far = basemapModel(prefs({ imageryPack: 'elsewhere' }), [world, elsewhere], [], SITE);
    expect(far.pack).toBeNull();
  });

  it('shades the terrain pack at the site, not a more detailed one elsewhere', () => {
    const m = basemapModel(prefs(), [], [demFar, dem], SITE);
    expect(m.hillshade).toBe(true);
    expect(m.draw.terrain.map((p) => p.id)).toEqual(['dem']);
    expect(basemapModel(prefs({ hillshade: false }), [], [dem], SITE).draw.hillshade).toBe(false);
    expect(basemapModel(prefs(), [], [demFar], SITE).hillshade).toBe(false);
  });

  it('offers every pack to a project that is not placed on the Earth', () => {
    const m = basemapModel(prefs(), [elsewhere], [demFar], null);
    expect(m.satellite).toBe(true);
    expect(m.hillshade).toBe(true);
  });

  describe('with online satellite switched on', () => {
    const on = (over: Partial<BasemapPrefs> = {}) => prefs({ onlineSatellite: true, ...over });

    it('Satellite can be chosen where no pack covers the site, and draws the online imagery', () => {
      const m = basemapModel(on(), [elsewhere], [], SITE);
      expect(m.satellite).toBe(true);
      expect(m.online).toBe(true);
      expect(m.packs).toEqual([]);
      expect(m.choice).toBe('satellite');
      // the packs elsewhere still draw (over it), so the map stays sharp where they are
      expect(m.draw).toEqual({
        imagery: [elsewhere],
        terrain: [],
        satellite: true,
        hillshade: false,
        streets: true,
        online: true,
      });
      expect(basemapModel(on(), [], [], SITE).draw).toMatchObject({ online: true, imagery: [] });
    });

    it('Satellite only keeps it and hides the streets', () => {
      const m = basemapModel(on({ streets: false }), [], [], SITE);
      expect(m.choice).toBe('imagery');
      expect(m.draw).toMatchObject({ satellite: true, streets: false, online: true });
    });

    it('is imagery like the packs: Streets draws none of it', () => {
      const m = basemapModel(on({ satellite: false }), [here], [], SITE);
      expect(m.choice).toBe('streets');
      expect(m.satellite).toBe(true);
      expect(m.draw).toMatchObject({ satellite: false, online: false, imagery: [], streets: true });
    });

    it('draws under the one pack chosen as under all of them', () => {
      const one = basemapModel(on({ imageryPack: 'here' }), [world, here], [], SITE);
      expect(one.draw.imagery.map((p) => p.id)).toEqual(['here']);
      expect(one.draw.online).toBe(true);
    });

    it('off, nothing changes: no pack, no Satellite', () => {
      const m = basemapModel(prefs(), [], [], SITE);
      expect(m.satellite).toBe(false);
      expect(m.online).toBe(false);
      expect(m.draw.online).toBe(false);
    });
  });

  it('the Online satellite row: what it is, greyed offline, or saved tiles only', () => {
    expect(onlineRow(false, false)).toEqual({
      availability: 'off',
      checked: false,
      disabled: false,
      note: 'detail',
    });
    expect(onlineRow(true, false)).toEqual({
      availability: 'online',
      checked: true,
      disabled: false,
      note: 'detail',
    });
    // offline only: it cannot be switched on
    expect(onlineRow(false, true)).toEqual({
      availability: 'off',
      checked: false,
      disabled: true,
      note: 'offline',
    });
    // already on: saved tiles still draw, and it can be switched off to hide them
    expect(onlineRow(true, true)).toEqual({
      availability: 'cached',
      checked: true,
      disabled: false,
      note: 'saved',
    });
  });

  it('remembers a map type as the choices the Settings checkboxes read', () => {
    expect(basemapPatch('streets')).toEqual({ satellite: false });
    expect(basemapPatch('satellite')).toEqual({ satellite: true, streets: true });
    expect(basemapPatch('imagery')).toEqual({ satellite: true, streets: false });
  });
});

describe('the ground around the site in 3D', () => {
  it('needs a pack at the site and a graphics preset that offers it', () => {
    expect(groundModel([here], [dem], SITE, true)).toEqual({
      offered: true,
      imagery: true,
      terrain: true,
    });
    expect(groundModel([elsewhere], [demFar], SITE, true)).toMatchObject({
      imagery: false,
      terrain: false,
    });
    expect(groundModel([here], [dem], SITE, false).offered).toBe(false);
    // not placed on the Earth: nothing to drape
    expect(groundModel([here], [dem], null, true)).toMatchObject({
      imagery: false,
      terrain: false,
    });
  });
});
