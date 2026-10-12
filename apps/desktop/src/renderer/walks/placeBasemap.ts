import type { StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { BasemapPrefs } from '../workspace/basemap';
import type { PlaceState } from './placeStore';

/*
 * Satellite under a walk placed on the map: the spots a walk starts and ends at are found on
 * imagery, not on the street map. While a session places a walk on the map, the map type turns to
 * Satellite when any imagery can be drawn (an imagery pack at the site, or online satellite), and
 * back to what it was when placing ends, unless the person chose another type meanwhile. The switch
 * is for the session only (`setForSession`): a quit while placing leaves the stored choice. Nothing
 * here knows the packs: the app hands in whether imagery is available (`walkMounts.tsx`), so the
 * strip can read `placeImagery` without loading the map's tile code.
 */

/** The map type choices this follows (`RasterPrefs` of `siteTiles.ts`). */
export type PlaceBasemapPrefs = Pick<BasemapPrefs, 'satellite' | 'streets'>;

export interface PlaceImagery {
  /** While placing on the map: whether any imagery can be drawn there; null when not placing on the map. */
  imagery: boolean | null;
}

export function createPlaceImagery(): StoreApi<PlaceImagery> {
  return createStore<PlaceImagery>()(() => ({ imagery: null }));
}

/** What the Place walk strip reads to say that no imagery can be shown. */
export const placeImagery = createPlaceImagery();

/** Satellite: imagery with the streets and names over it (`basemapPatch('satellite')`). */
const SATELLITE: PlaceBasemapPrefs = { satellite: true, streets: true };

/** Follow the session and the map type choices; returns the unsubscribe. */
export function followPlaceBasemap(
  session: StoreApi<PlaceState>,
  raster: StoreApi<{
    prefs: PlaceBasemapPrefs;
    setForSession(patch: Partial<PlaceBasemapPrefs>): void;
  }>,
  available: () => boolean,
  out: StoreApi<PlaceImagery> = placeImagery,
): () => void {
  /** The choices before the switch, while switched (null: not switched this session). */
  let before: PlaceBasemapPrefs | null = null;
  /** This session's switch is settled (made, or not needed): a later choice is the person's. */
  let settled = false;
  let busy = false;
  const tell = (imagery: boolean | null): void => {
    if (out.getState().imagery !== imagery) out.setState({ imagery });
  };
  const update = (): void => {
    if (busy) return;
    busy = true;
    try {
      const s = session.getState();
      const prefs = raster.getState().prefs;
      if (s.layerId === null || s.surface?.kind !== 'map') {
        // placing ended: back to the type it was, unless the person picked another meanwhile
        if (before && prefs.satellite && prefs.streets) raster.getState().setForSession(before);
        before = null;
        settled = false;
        tell(null);
        return;
      }
      const imagery = available();
      tell(imagery);
      if (settled) return;
      if (prefs.satellite) settled = true;
      else if (imagery) {
        settled = true;
        before = { satellite: prefs.satellite, streets: prefs.streets };
        raster.getState().setForSession(SATELLITE);
      }
    } finally {
      busy = false;
    }
  };
  const stops = [session.subscribe(update), raster.subscribe(update)];
  update();
  return () => {
    for (const stop of stops) stop();
  };
}
