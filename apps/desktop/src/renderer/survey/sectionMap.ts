/**
 * The section on the map (M11 G5): its line, a corridor band either side and its pins, as one
 * GeoJSON source on the map on screen, following the section store.
 */
import { toWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import { corridorRing, lineLength } from '@aio/survey';
import { isDismissed, sectionStore } from './sectionStore';

const SRC = 'aio-section';
const LAYERS = ['aio-section-band', 'aio-section-line', 'aio-section-pin'] as const;
export const SECTION_LINE_COLOUR = '#4cc9f0';

/** Half the band's width: 2% of the line, between 0.5 and 5 m. */
export const bandHalfWidth = (length: number) => Math.min(5, Math.max(0.5, length * 0.02));

export function attachSectionMap(ctl: MapController, epsg: number | null): () => void {
  if (epsg === null) return () => undefined;
  const map = ctl.map;
  const ll = (e: number, n: number): [number, number] => {
    const p = toWgs84([e, n, 0], epsg);
    return [p[0], p[1]];
  };
  const data = () => {
    const s = sectionStore.getState();
    const features: unknown[] = [];
    if (s.line && s.line.length >= 2 && !isDismissed(s)) {
      const ring = corridorRing(s.line, bandHalfWidth(lineLength(s.line)));
      if (ring.length >= 3)
        features.push({
          type: 'Feature',
          properties: { part: 'band' },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [...ring.map(([e, n]) => ll(e, n)), ll(ring[0]?.[0] ?? 0, ring[0]?.[1] ?? 0)],
            ],
          },
        });
      features.push({
        type: 'Feature',
        properties: { part: 'line' },
        geometry: { type: 'LineString', coordinates: s.line.map(([e, n]) => ll(e, n)) },
      });
      for (const p of s.pins)
        features.push({
          type: 'Feature',
          properties: { part: 'pin' },
          geometry: { type: 'Point', coordinates: ll(p.e, p.n) },
        });
    }
    return { type: 'FeatureCollection', features };
  };
  const draw = () => {
    try {
      if (!map.isStyleLoaded()) return;
      const src = map.getSource(SRC) as { setData?: (d: unknown) => void } | undefined;
      if (src?.setData) src.setData(data());
      else map.addSource(SRC, { type: 'geojson', data: data() as never });
      if (!map.getLayer(LAYERS[0]))
        map.addLayer({
          id: LAYERS[0],
          type: 'fill',
          source: SRC,
          filter: ['==', ['get', 'part'], 'band'],
          paint: { 'fill-color': SECTION_LINE_COLOUR, 'fill-opacity': 0.16 },
        });
      if (!map.getLayer(LAYERS[1]))
        map.addLayer({
          id: LAYERS[1],
          type: 'line',
          source: SRC,
          filter: ['==', ['get', 'part'], 'line'],
          paint: { 'line-color': SECTION_LINE_COLOUR, 'line-width': 2.5, 'line-dasharray': [3, 1] },
        });
      if (!map.getLayer(LAYERS[2]))
        map.addLayer({
          id: LAYERS[2],
          type: 'circle',
          source: SRC,
          filter: ['==', ['get', 'part'], 'pin'],
          paint: {
            'circle-radius': 5,
            'circle-color': '#ffffff',
            'circle-stroke-color': SECTION_LINE_COLOUR,
            'circle-stroke-width': 2,
          },
        });
    } catch {
      // the style is being replaced: drawn again on its next load
    }
  };
  const onStyle = () => {
    draw();
  };
  map.on('styledata', onStyle);
  const off = sectionStore.subscribe((s, prev) => {
    if (s.line !== prev.line || s.pins !== prev.pins || s.dismissed !== prev.dismissed) draw();
  });
  draw();
  return () => {
    off();
    map.off('styledata', onStyle);
    try {
      for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    } catch {
      // the map is going away
    }
  };
}
