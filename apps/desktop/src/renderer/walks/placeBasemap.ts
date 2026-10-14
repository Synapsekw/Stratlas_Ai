import type { StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { BasemapPrefs, PlaceLook } from '../workspace/basemap';
import type { PlaceState } from './placeStore';

/*
 * Imagery under a walk placed on the map: the spots a walk starts and ends at are found on
 * imagery, not on the street map. While a session places a walk on the map, the map turns to
 * imagery when any can be drawn (the imagery packs on top when one covers the site, else the
 * online satellite as the base map), and back to what it was when placing ends, unless the person
 * chose another map meanwhile. The switch is for the session only (`setForSession`): a quit while
 * placing leaves the stored choice. Nothing here knows the packs: the app hands in what to switch
 * to (`placeLook`, wired in `walkMounts.tsx`), so the strip can read `placeImagery` without
 * loading the map's tile code.
 */

export type { PlaceLook };

/** The map choices this follows (`RasterPrefs` of `siteTiles.ts`). */
export type PlaceBasemapPrefs = Pick<BasemapPrefs, 'satellite' | 'streets' | 'mapBase'>;

export interface PlaceImagery {
  /** While placing on the map: whether any imagery can be drawn there; null when not placing on the map. */
  imagery: boolean | null;
}

export function createPlaceImagery(): StoreApi<PlaceImagery> {
  return createStore<PlaceImagery>()(() => ({ imagery: null }));
}

/** What the Place walk strip reads to say that no imagery can be shown. */
export const placeImagery = createPlaceImagery();

/** Follow the session and the map type choices; returns the unsubscribe. */
export function followPlaceBasemap(
  session: StoreApi<PlaceState>,
  raster: StoreApi<{
    prefs: PlaceBasemapPrefs;
    /** Bumped by every map type the person picks (`RasterState.chosen`). */
    chosen: number;
    setForSession(patch: Partial<PlaceBasemapPrefs>): void;
  }>,
  look: () => PlaceLook,
  out: StoreApi<PlaceImagery> = placeImagery,
): () => void {
  /** The choices before the switch, while switched (null: not switched this session). */
  let before: Partial<PlaceBasemapPrefs> | null = null;
  /** `chosen` when the switch was made: a pick since then is the person's and stays. */
  let pickedAt = 0;
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
        const picked = raster.getState().chosen !== pickedAt;
        if (before && !picked) raster.getState().setForSession(before);
        before = null;
        settled = false;
        tell(null);
        return;
      }
      const { imagery, switchTo } = look();
      tell(imagery);
      if (settled || !imagery) return;
      settled = true;
      if (switchTo) {
        // what the switch changes, as it was, to restore when placing ends
        before = Object.fromEntries(
          Object.keys(switchTo).map((k) => [k, prefs[k as keyof PlaceBasemapPrefs] ?? null]),
        );
        pickedAt = raster.getState().chosen;
        raster.getState().setForSession(switchTo);
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
