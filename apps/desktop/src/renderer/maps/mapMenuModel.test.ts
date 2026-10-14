import { ONLINE_SOURCES, onlineSource, type MapKeysStatus } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  drawnBase,
  mapMenuModel,
  tileState,
  type MapMenuPrefs,
  type MenuOnline,
  type MenuPacks,
} from './mapMenuModel';

const ON: MenuOnline = { enabled: true, offlineOnly: false };
const OFF: MenuOnline = { enabled: false, offlineOnly: false };
const OFFLINE_ONLY: MenuOnline = { enabled: true, offlineOnly: true };
const NO_KEYS: MapKeysStatus = { esri: false, mapbox: false };
const KEYS: MapKeysStatus = { esri: false, mapbox: true };
const PACKS: MenuPacks = { imagery: [{ id: 'site', label: 'Site imagery' }], terrain: 1 };
const NONE: MenuPacks = { imagery: [], terrain: 0 };
const prefs = (over: Partial<MapMenuPrefs> = {}): MapMenuPrefs => ({
  base: 'streets',
  onTop: {},
  pack: null,
  ...over,
});
const tileOf = (m: ReturnType<typeof mapMenuModel>, id: string) =>
  m.sections.flatMap((s) => s.tiles).find((t) => t.id === id);
const row = (m: ReturnType<typeof mapMenuModel>, key: string) => m.onTop.find((r) => r.key === key);

describe('tile states', () => {
  const esri = onlineSource('esri-world-imagery');
  const mapbox = onlineSource('mapbox-streets');
  const s2 = onlineSource('s2cloudless-2016');
  if (!esri || !mapbox || !s2) throw new Error('catalog');

  it('Esri works without a key, Mapbox needs one', () => {
    expect(tileState(esri, ON, NO_KEYS)).toBe('available');
    expect(tileState(mapbox, ON, NO_KEYS)).toBe('needs-key');
    expect(tileState(mapbox, ON, KEYS)).toBe('available');
    // online maps off: still pickable, the pick asks to switch them on
    expect(tileState(esri, OFF, NO_KEYS)).toBe('available');
  });

  it('offline-only greys every source except saved Sentinel-2 while online maps are on', () => {
    expect(tileState(esri, OFFLINE_ONLY, NO_KEYS)).toBe('offline');
    expect(tileState(mapbox, OFFLINE_ONLY, KEYS)).toBe('offline');
    expect(tileState(s2, OFFLINE_ONLY, NO_KEYS)).toBe('available');
    expect(tileState(s2, { enabled: false, offlineOnly: true }, NO_KEYS)).toBe('offline');
  });
});

describe('what is drawn', () => {
  it('draws the chosen source when it can', () => {
    expect(drawnBase('esri-world-imagery', ON, NO_KEYS)).toEqual({
      base: 'esri-world-imagery',
      fallback: false,
    });
    expect(drawnBase('natural-earth', OFF, NO_KEYS)).toEqual({
      base: 'natural-earth',
      fallback: false,
    });
  });

  it('offline-only draws saved Sentinel-2 when online maps are on', () => {
    expect(drawnBase('esri-world-imagery', OFFLINE_ONLY, NO_KEYS)).toEqual({
      base: 's2cloudless-2016',
      fallback: true,
    });
    expect(drawnBase('s2cloudless-2016', OFFLINE_ONLY, NO_KEYS)).toEqual({
      base: 's2cloudless-2016',
      fallback: false,
    });
  });

  it('falls back to the street map without a key or with online maps off', () => {
    expect(drawnBase('mapbox-dark', ON, NO_KEYS)).toEqual({ base: 'streets', fallback: true });
    expect(drawnBase('esri-world-imagery', OFF, NO_KEYS)).toEqual({
      base: 'streets',
      fallback: true,
    });
    expect(drawnBase('mapbox-dark', { enabled: false, offlineOnly: true }, KEYS)).toEqual({
      base: 'streets',
      fallback: true,
    });
  });
});

describe('the menu of each view', () => {
  it('groups the tiles: Offline, Online satellite (Esri, Mapbox, Sentinel-2), Mapbox styles', () => {
    const m = mapMenuModel('map', prefs(), ONLINE_SOURCES, PACKS, ON, NO_KEYS);
    expect(m.sections.map((s) => [s.id, s.tiles.map((t) => t.id)])).toEqual([
      ['offline', ['streets']],
      ['satellite', ['esri-world-imagery', 'mapbox-satellite', 's2cloudless-2016']],
      [
        'mapbox',
        [
          'mapbox-streets',
          'mapbox-outdoors',
          'mapbox-light',
          'mapbox-dark',
          'mapbox-satellite-streets',
        ],
      ],
    ]);
    expect(tileOf(m, 'streets')?.selected).toBe(true);
    expect(
      mapMenuModel('globe', prefs(), ONLINE_SOURCES, PACKS, ON, NO_KEYS).sections[0]?.tiles.map(
        (t) => t.id,
      ),
    ).toEqual(['streets', 'natural-earth']);
  });

  it('greys a Mapbox style without a key, with the reason under its section', () => {
    const m = mapMenuModel('map', prefs(), ONLINE_SOURCES, PACKS, ON, NO_KEYS);
    expect(tileOf(m, 'mapbox-streets')).toMatchObject({
      state: 'needs-key',
      reason: 'mapMenu.reason.needsKey',
      badge: 'mapMenu.badge.needsKey',
    });
    expect(m.sections.find((s) => s.id === 'mapbox')?.note).toBe('mapMenu.reason.needsKey');
    expect(m.sections.find((s) => s.id === 'satellite')?.note).toBe('mapMenu.reason.needsKey');
    expect(tileOf(m, 'esri-world-imagery')?.state).toBe('available');
  });

  it('the 3D scene needs Medium graphics for an online base', () => {
    const m = mapMenuModel('scene', prefs(), ONLINE_SOURCES, PACKS, ON, KEYS, {
      aroundOffered: false,
    });
    expect(tileOf(m, 'esri-world-imagery')).toMatchObject({
      state: 'tier',
      reason: 'mapMenu.reason.tier',
    });
    expect(tileOf(m, 'streets')?.state).toBe('available');
    expect(row(m, 'aroundImagery')).toMatchObject({
      disabled: true,
      reason: 'mapMenu.reason.tier',
    });
  });

  it('Map view On top: street names over imagery only, shading and packs need a pack', () => {
    const streets = mapMenuModel('map', prefs(), ONLINE_SOURCES, NONE, ON, NO_KEYS);
    expect(streets.onTop.map((r) => r.key)).toEqual(['streets', 'hillshade', 'packs']);
    expect(row(streets, 'streets')).toMatchObject({
      disabled: true,
      reason: 'mapMenu.reason.noImageryUnder',
    });
    expect(row(streets, 'hillshade')).toMatchObject({
      disabled: true,
      reason: 'mapMenu.reason.noTerrain',
    });
    expect(row(streets, 'packs')).toMatchObject({
      disabled: true,
      reason: 'mapMenu.reason.noImagery',
    });

    const esri = mapMenuModel(
      'map',
      prefs({ base: 'esri-world-imagery' }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
    );
    expect(row(esri, 'streets')).toMatchObject({ disabled: false, on: true });
    const labelled = mapMenuModel(
      'map',
      prefs({ base: 'mapbox-satellite-streets' }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      KEYS,
    );
    expect(row(labelled, 'streets')).toMatchObject({
      disabled: true,
      on: false,
      reason: 'mapMenu.reason.labelsInBase',
    });
    const packsOn = mapMenuModel(
      'map',
      prefs({ onTop: { packs: true, streets: false } }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
    );
    expect(row(packsOn, 'streets')).toMatchObject({ disabled: false, on: false });
    expect(packsOn.showPackPicker).toBe(true);
  });

  it('Globe On top: packs, terrain and issues; terrain off on the Low preset', () => {
    const m = mapMenuModel(
      'globe',
      prefs({ onTop: { packs: true } }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
      {
        terrainOffered: false,
      },
    );
    expect(m.onTop.map((r) => r.key)).toEqual(['packs', 'terrain', 'issues']);
    expect(row(m, 'terrain')).toMatchObject({
      disabled: true,
      on: false,
      reason: 'mapMenu.reason.lowTier',
    });
    expect(row(m, 'issues')).toMatchObject({ disabled: false, on: true });
    expect(m.showPackPicker).toBe(true);
  });

  it('the chip names the chosen map and notes a fallback; the footer credits what is drawn', () => {
    const fallback = mapMenuModel(
      'map',
      prefs({ base: 'mapbox-dark' }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
    );
    expect(fallback).toMatchObject({
      chosen: 'mapbox-dark',
      drawn: 'streets',
      fallback: true,
      chip: 'mapMenu.tile.mapboxDark',
      chipSwatch: 'dark',
      credit: '© OpenStreetMap contributors',
    });
    const esri = mapMenuModel(
      'map',
      prefs({ base: 'esri-world-imagery' }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
    );
    expect(esri.credit).toContain('Powered by Esri');
    const ne = mapMenuModel(
      'globe',
      prefs({ base: 'natural-earth' }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
    );
    expect(ne.credit).toBe('Natural Earth II (public domain)');
  });
});
