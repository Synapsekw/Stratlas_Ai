import { fitWalk } from '@aio/geo';
import { ProjectManifest, type WalkLayer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createPlaceImagery, followPlaceBasemap, type PlaceBasemapPrefs } from './placeBasemap';
import { createPlaceStore } from './placeStore';

const walk: WalkLayer = {
  kind: 'walk',
  id: 'walk-a',
  name: 'Walk A',
  visible: true,
  capture: 'c1',
  record: { path: 'walks/a/walk.json' },
  src: { path: 'walks/a/playback.mp4' },
  durationS: 62,
};

const m = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32633 },
  origin: [0, 0, 0],
  captures: [{ id: 'c1', label: 'First', date: '2026-01-01' }],
  layers: [walk],
  severityModels: [],
  classCatalogues: [],
});

function setup(prefs: PlaceBasemapPrefs, imagery: { on: boolean }) {
  const session = createPlaceStore({ fit: fitWalk, seek: () => undefined });
  const raster = createStore<{
    prefs: PlaceBasemapPrefs;
    set(p: Partial<PlaceBasemapPrefs>): void;
    setForSession(p: Partial<PlaceBasemapPrefs>): void;
  }>()((set, get) => ({
    prefs,
    // the person's choice (stored)
    set: (p) => {
      stored.push(p);
      set({ prefs: { ...get().prefs, ...p } });
    },
    setForSession: (p) => {
      set({ prefs: { ...get().prefs, ...p } });
    },
  }));
  const stored: Partial<PlaceBasemapPrefs>[] = [];
  const out = createPlaceImagery();
  const stop = followPlaceBasemap(session, raster, () => imagery.on, out);
  const startOnMap = () => {
    session.getState().start(walk, m);
    session.getState().chooseSurface({ kind: 'map' });
  };
  return {
    session,
    raster,
    out,
    stop,
    startOnMap,
    stored,
    prefs: () => raster.getState().prefs,
  };
}

describe('followPlaceBasemap', () => {
  it('placing on the map switches Streets to Satellite, and back when placing ends', () => {
    const k = setup({ satellite: false, streets: false }, { on: true });
    k.startOnMap();
    expect(k.prefs()).toEqual({ satellite: true, streets: true });
    expect(k.out.getState().imagery).toBe(true);
    k.session.getState().cancel();
    expect(k.prefs()).toEqual({ satellite: false, streets: false });
    expect(k.out.getState().imagery).toBeNull();
    // the switch and its undoing are for the session only: nothing is stored
    expect(k.stored).toEqual([]);
    k.stop();
  });

  it('a choice the person makes while placing is kept', () => {
    const k = setup({ satellite: false, streets: true }, { on: true });
    k.startOnMap();
    k.raster.getState().set({ satellite: false });
    // not switched again while the same walk is placed
    k.session.getState().setTime(3);
    expect(k.prefs().satellite).toBe(false);
    k.session.getState().cancel();
    expect(k.prefs()).toEqual({ satellite: false, streets: true });
    k.stop();
  });

  it('no imagery: nothing switched, the strip is told; imagery arriving later switches', () => {
    const imagery = { on: false };
    const k = setup({ satellite: false, streets: true }, imagery);
    k.startOnMap();
    expect(k.prefs().satellite).toBe(false);
    expect(k.out.getState().imagery).toBe(false);
    // online satellite switched on from the picker: the raster store changes
    imagery.on = true;
    k.raster.getState().set({});
    expect(k.prefs().satellite).toBe(true);
    expect(k.out.getState().imagery).toBe(true);
    k.stop();
  });

  it('Satellite already chosen, or placing on a drawing: nothing changes', () => {
    const k = setup({ satellite: true, streets: false }, { on: true });
    k.startOnMap();
    // turned to Streets by the person: not switched back
    k.raster.getState().set({ satellite: false });
    k.session.getState().setTime(3);
    expect(k.prefs().satellite).toBe(false);
    k.session.getState().cancel();
    expect(k.prefs()).toEqual({ satellite: false, streets: false });
    const d = setup({ satellite: false, streets: true }, { on: true });
    d.session.getState().start(walk, m);
    d.session
      .getState()
      .chooseSurface({ kind: 'drawing', id: 'sheet', name: 'Plan', dated: false });
    expect(d.prefs().satellite).toBe(false);
    expect(d.out.getState().imagery).toBeNull();
    k.stop();
    d.stop();
  });
});
