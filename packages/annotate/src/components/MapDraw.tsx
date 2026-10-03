import { useCallback, useState } from 'react';
import { beginSighting } from '../runtime';
import {
  initialMapDraw,
  mapDrawReducer,
  mapSightingFromDraw,
  type LngLat,
  type MapDrawEvent,
  type MapDrawMode,
  type MapDrawState,
} from '../tools/map';

export interface MapDraw {
  mode: MapDrawMode | null;
  setMode: (m: MapDrawMode | null) => void;
  /** Vertices drawn so far, for a preview layer. */
  state: MapDrawState | null;
  onClick: (lngLat: LngLat, client?: { x: number; y: number }) => void;
  finish: () => void;
  undo: () => void;
  cancel: () => void;
}

/**
 * Seam for MapView (stream S5): point, line and polygon drawing on the map. Wire MapLibre `click`
 * to `onClick([lng, lat], {x, y})`, `dblclick` and Enter to `finish`, Backspace to `undo`, Esc to
 * `cancel`; draw `state.vertices` as a preview; mount `<SightingPicker kinds={['map']} />`.
 * A finished shape opens the class and severity picker and becomes a map sighting on `layerId`.
 */
export function useMapDraw(layerId: string): MapDraw {
  const [mode, setModeState] = useState<MapDrawMode | null>(null);
  const [state, setState] = useState<MapDrawState | null>(null);

  const step = useCallback(
    (e: MapDrawEvent, client?: { x: number; y: number }) => {
      setState((s) => {
        if (!s) return s;
        const next = mapDrawReducer(s, e);
        const sighting = mapSightingFromDraw(layerId, next);
        if (sighting) {
          beginSighting(sighting, client);
          return initialMapDraw(next.mode);
        }
        return next;
      });
    },
    [layerId],
  );

  return {
    mode,
    state,
    setMode: (m) => {
      setModeState(m);
      setState(m ? initialMapDraw(m) : null);
    },
    onClick: (lngLat, client) => {
      step({ type: 'click', lngLat }, client);
    },
    finish: () => {
      step({ type: 'finish' });
    },
    undo: () => {
      step({ type: 'undo' });
    },
    cancel: () => {
      step({ type: 'cancel' });
    },
  };
}
