import type { Feature, FeatureCollection } from 'geojson';

export type MapDrawMode = 'point' | 'line' | 'polygon';
export type MapLngLat = [number, number];

/**
 * The click seam for drawing on the map (map sightings). While `mode` is set, map clicks go to
 * `onClick` instead of selecting, a double click calls `onFinish` instead of zooming, the cursor
 * is a crosshair, and `vertices` are drawn as a preview.
 */
export interface MapDrawSeam {
  mode: MapDrawMode | null;
  vertices: readonly MapLngLat[];
  onClick(lngLat: MapLngLat, client: { x: number; y: number }): void;
  onFinish(): void;
}

/** Preview of the shape being drawn: the vertices, plus the line (or open ring) through them. */
export function drawPreview(
  mode: MapDrawMode | null,
  vertices: readonly MapLngLat[],
): FeatureCollection {
  if (!mode || vertices.length === 0) return { type: 'FeatureCollection', features: [] };
  const features: Feature[] = vertices.map((v) => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [...v] },
  }));
  if (mode !== 'point' && vertices.length > 1) {
    const ring = vertices.map((v) => [...v]);
    const first = vertices[0];
    if (mode === 'polygon' && vertices.length > 2 && first) ring.push([...first]);
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: ring },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * The two clicks of a double click (and an accidental second click) land on the same spot: only
 * a click away from the previous one, or after a pause, adds a vertex.
 */
export function isRepeatClick(
  prev: { x: number; y: number; t: number } | null,
  next: { x: number; y: number; t: number },
  slopPx = 4,
  windowMs = 450,
): boolean {
  if (!prev) return false;
  return Math.hypot(next.x - prev.x, next.y - prev.y) <= slopPx && next.t - prev.t <= windowMs;
}
