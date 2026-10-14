import type { RasterPackInfo } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  basemapModel,
  coveringPacks,
  groundModel,
  NO_ONLINE,
  placeLook,
  resolveMapBase,
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
    expect(m.satellite).toBe(false);
    expect(m.hillshade).toBe(false);
    expect(m.draw).toEqual({
      imagery: [],
      terrain: [],
      satellite: false,
      hillshade: false,
      streets: true,
      online: null,
    });
  });

  it('Satellite draws every installed pack, so the map stays covered away from the site', () => {
    const m = basemapModel(prefs(), [world, elsewhere, here], [dem], SITE);
    expect(m.packs.map((p) => p.id)).toEqual(['here', 'world']);
    expect(m.pack).toBeNull();
    expect(m.draw.imagery.map((p) => p.id)).toEqual(['world', 'elsewhere', 'here']);
    expect(m.draw.streets).toBe(true);
    expect(m.hillshadeOn).toBe(true);
  });

  it('Satellite only hides the streets; Streets shows them again', () => {
    const only = basemapModel(prefs({ streets: false }), [world], [], SITE);
    expect(only.draw).toMatchObject({ satellite: true, streets: false });
    // the streets are never hidden without imagery under them
    const off = basemapModel(prefs({ streets: false, satellite: false }), [world], [], SITE);
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
    const S2 = { ...NO_ONLINE, source: 's2cloudless-2016' as const };

    it('Satellite can be chosen where no pack covers the site, and draws the online imagery', () => {
      const m = basemapModel(on(), [elsewhere], [], SITE, S2);
      expect(m.satellite).toBe(true);
      expect(m.online).toBe(true);
      expect(m.packs).toEqual([]);
      // a pack that does not reach the site is not drawn, online or not
      expect(m.draw).toEqual({
        imagery: [],
        terrain: [],
        satellite: false,
        hillshade: false,
        streets: true,
        online: 's2cloudless-2016',
      });
      expect(basemapModel(on(), [], [], SITE, S2).draw).toMatchObject({
        online: 's2cloudless-2016',
        imagery: [],
      });
    });

    it('Satellite only keeps it and hides the streets', () => {
      const m = basemapModel(on({ streets: false }), [], [], SITE, S2);
      expect(m.draw).toMatchObject({
        satellite: false,
        streets: false,
        online: 's2cloudless-2016',
      });
    });

    it('is imagery like the packs: Streets draws none of it', () => {
      const m = basemapModel(on({ satellite: false }), [here], [], SITE, S2);
      expect(m.satellite).toBe(true);
      expect(m.draw).toMatchObject({ satellite: false, online: null, imagery: [], streets: true });
    });

    it('draws under the one pack chosen as under all of them', () => {
      const one = basemapModel(on({ imageryPack: 'here' }), [world, here], [], SITE, S2);
      expect(one.draw.imagery.map((p) => p.id)).toEqual(['here']);
      expect(one.draw.online).toBe('s2cloudless-2016');
    });

    it('off, nothing changes: no pack, no Satellite', () => {
      const m = basemapModel(prefs(), [], [], SITE);
      expect(m.satellite).toBe(false);
      expect(m.online).toBe(false);
      expect(m.draw.online).toBeNull();
    });
  });
});

describe('the ground around the site in 3D', () => {
  it('needs a pack at the site and a graphics preset that offers it', () => {
    expect(groundModel([here], [dem], SITE, true)).toEqual({
      offered: true,
      imagery: true,
      terrain: true,
      online: false,
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

describe('the base map of the Map menu', () => {
  const S2 = { ...NO_ONLINE, source: 's2cloudless-2016' as const };

  it('legacy Satellite with online on draws the preferred source; Streets draws none', () => {
    const m = basemapModel(prefs({ onlineSatellite: true }), [], [], SITE, S2);
    expect(m.base).toBe('s2cloudless-2016');
    expect(m.draw.online).toBe('s2cloudless-2016');
    expect(resolveMapBase(prefs({ satellite: false, onlineSatellite: true }), S2)).toBe('streets');
    expect(
      basemapModel(prefs({ satellite: false, onlineSatellite: true }), [], [], SITE, S2).draw
        .online,
    ).toBeNull();
  });

  it('an explicit base wins; a map with its own labels hides the street overlay', () => {
    const keys = { esri: false, mapbox: true };
    const m = basemapModel(
      prefs({ onlineSatellite: true, mapBase: 'mapbox-satellite-streets' }),
      [here],
      [],
      SITE,
      { ...NO_ONLINE, keys },
    );
    expect(m.draw).toMatchObject({
      online: 'mapbox-satellite-streets',
      streets: false,
      satellite: true,
    });
  });

  it('falls back to the street map when the key goes', () => {
    const m = basemapModel(
      prefs({ onlineSatellite: true, mapBase: 'mapbox-dark' }),
      [],
      [],
      SITE,
      NO_ONLINE,
    );
    expect(m).toMatchObject({ base: 'mapbox-dark', drawn: 'streets', fallback: true });
    expect(m.draw.online).toBeNull();
    expect(m.draw.streets).toBe(true);
  });

  it('offline-only with online maps on falls back to the offline street map', () => {
    const m = basemapModel(
      prefs({ onlineSatellite: true, mapBase: 'esri-world-imagery' }),
      [],
      [],
      SITE,
      { ...NO_ONLINE, offlineOnly: true },
    );
    expect(m).toMatchObject({ drawn: 'streets', fallback: true });
    expect(m.draw.online).toBeNull();
    expect(m.draw.streets).toBe(true);
  });

  it('packs on top of Esri; street names over imagery follow the switch', () => {
    const m = basemapModel(
      prefs({ onlineSatellite: true, mapBase: 'esri-world-imagery', streets: false }),
      [here],
      [],
      SITE,
      NO_ONLINE,
    );
    expect(m.draw).toMatchObject({ online: 'esri-world-imagery', satellite: true, streets: false });
    expect(m.draw.imagery.map((p) => p.id)).toEqual(['here']);
  });

  it('Place walk on a site without packs still shows imagery (Satellite for the session)', () => {
    const m = basemapModel(
      prefs({ satellite: true, onlineSatellite: true }),
      [],
      [],
      SITE,
      NO_ONLINE,
    );
    expect(m.satellite).toBe(true);
    expect(m.draw.online).toBe('esri-world-imagery');
  });
});

describe('imagery for Place walk', () => {
  const ESRI = NO_ONLINE;

  it('a picked street base, online maps on, no pack: turns the base to the online satellite', () => {
    const look = placeLook(
      prefs({ satellite: true, onlineSatellite: true, mapBase: 'streets' }),
      [elsewhere],
      [],
      SITE,
      ESRI,
    );
    expect(look).toEqual({
      imagery: true,
      switchTo: { mapBase: 'esri-world-imagery', streets: true },
    });
  });

  it('online imagery already drawn, or 0.11 Satellite with online on: nothing to switch', () => {
    expect(
      placeLook(
        prefs({ onlineSatellite: true, mapBase: 'esri-world-imagery' }),
        [],
        [],
        SITE,
        ESRI,
      ),
    ).toEqual({ imagery: true, switchTo: null });
    expect(placeLook(prefs({ onlineSatellite: true }), [], [], SITE, ESRI)).toEqual({
      imagery: true,
      switchTo: null,
    });
  });

  it('a pack covers the site: imagery packs on top, whatever the base', () => {
    expect(
      placeLook(prefs({ satellite: false, streets: false, mapBase: 'streets' }), [here], [], SITE),
    ).toEqual({ imagery: true, switchTo: { satellite: true, streets: true } });
    expect(placeLook(prefs({ satellite: true }), [here], [], SITE)).toEqual({
      imagery: true,
      switchTo: null,
    });
  });

  it('respects offline-only and keys: no imagery when the online satellite cannot be drawn', () => {
    const on = prefs({ onlineSatellite: true, mapBase: 'streets' });
    expect(placeLook(on, [], [], SITE, { ...ESRI, offlineOnly: true })).toEqual({
      imagery: false,
      switchTo: null,
    });
    expect(placeLook(on, [], [], SITE, { ...ESRI, source: 'mapbox-satellite' })).toEqual({
      imagery: false,
      switchTo: null,
    });
    expect(placeLook(prefs({ mapBase: 'streets' }), [], [], SITE, ESRI)).toEqual({
      imagery: false,
      switchTo: null,
    });
    // the model agrees: Place walk reads the same answer
    expect(basemapModel(on, [], [], SITE, { ...ESRI, offlineOnly: true }).satellite).toBe(false);
  });
});

describe('the ground with an online base in 3D', () => {
  it('says when an online map is drawn around the site', () => {
    expect(groundModel([], [], SITE, true, true)).toMatchObject({ online: true, imagery: false });
    expect(groundModel([here], [dem], SITE, true)).toMatchObject({ online: false });
  });
});
