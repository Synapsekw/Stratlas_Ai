import type { Sighting } from '@aio/schema';

/**
 * Map sightings (ANN-5): point, line and polygon in WGS84 longitude/latitude, stored as GeoJSON.
 *
 * Seam for MapView (stream S5): forward map clicks to `mapDrawReducer` (or the `useMapDraw` hook
 * in `components/MapDraw.tsx`) and draw `state.vertices` as a preview layer; on `done`, pass
 * `mapSightingFromDraw(layer, state)` to `beginSighting` so the class and severity picker opens.
 */
export type MapSighting = Extract<Sighting, { on: 'map' }>;
export type LngLat = [number, number];
export type MapDrawMode = 'point' | 'line' | 'polygon';

export interface MapDrawState {
  mode: MapDrawMode;
  vertices: LngLat[];
  done: boolean;
}

export type MapDrawEvent =
  { type: 'click'; lngLat: LngLat } | { type: 'finish' } | { type: 'undo' } | { type: 'cancel' };

export function initialMapDraw(mode: MapDrawMode): MapDrawState {
  return { mode, vertices: [], done: false };
}

const minVertices = (mode: MapDrawMode) => (mode === 'point' ? 1 : mode === 'line' ? 2 : 3);

export function mapDrawReducer(s: MapDrawState, e: MapDrawEvent): MapDrawState {
  switch (e.type) {
    case 'click': {
      const base = s.done ? [] : s.vertices;
      const vertices = [...base, e.lngLat];
      return { ...s, vertices, done: s.mode === 'point' };
    }
    case 'finish':
      return s.vertices.length >= minVertices(s.mode) ? { ...s, done: true } : s;
    case 'undo':
      return { ...s, vertices: s.vertices.slice(0, -1), done: false };
    case 'cancel':
      return initialMapDraw(s.mode);
  }
}

/** The finished drawing as a map sighting, or null while it is still being drawn. */
export function mapSightingFromDraw(layer: string, s: MapDrawState): MapSighting | null {
  if (!s.done) return null;
  const v = s.vertices;
  const first = v[0];
  if (!first) return null;
  if (s.mode === 'point') {
    return { on: 'map', layer, geojson: { type: 'Point', coordinates: first } };
  }
  if (s.mode === 'line') {
    return { on: 'map', layer, geojson: { type: 'LineString', coordinates: v } };
  }
  return { on: 'map', layer, geojson: { type: 'Polygon', coordinates: [[...v, first]] } };
}
