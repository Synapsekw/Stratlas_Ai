// Browser-only: the small MapLibre map behind PackCoverage. Loaded lazily.
import { Map as MapLibreMap, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import { coverageFeatures, dragBbox } from './coverageData';
import type { Bbox, MapPack } from './packs';
import { MAP_INK } from './ink';
import { installBasemap } from './runtime';
import { buildStyle } from './style';

export interface CoverageState {
  packs: readonly MapPack[];
  highlight: string | null;
  draft: Bbox | null;
  drawing: boolean;
}

/** Pack outlines, the highlighted pack and the draft region, on the (always dark) street map. */
const c = { line: MAP_INK.fg2, hi: MAP_INK.accStrong, draft: MAP_INK.warn } as const;

export function createCoverageMap(
  el: HTMLElement,
  initial: CoverageState,
  onDraw: (bbox: Bbox) => void,
) {
  installBasemap(initial.packs);
  const map = new MapLibreMap({
    container: el,
    style: buildStyle({
      lang: document.documentElement.lang.startsWith('ar') ? 'ar' : 'en',
      maxZoom: Math.max(6, ...initial.packs.map((p) => p.maxZoom)),
    }),
    center: [45, 24],
    zoom: 1.2,
    minZoom: 0,
    maxZoom: 9,
    renderWorldCopies: false,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  // Test hook: end-to-end tests read the style through the container.
  Object.assign(el, { __aioMap: map });

  let state = initial;
  let loaded = false;
  let start: { lng: number; lat: number } | null = null;

  const push = () => {
    if (!loaded) return;
    const fc = coverageFeatures(state.packs, state.highlight, state.draft);
    void map.getSource<GeoJSONSource>('cov-packs')?.setData(fc.packs);
    void map.getSource<GeoJSONSource>('cov-draft')?.setData(fc.draft);
    if (state.drawing) map.dragPan.disable();
    else map.dragPan.enable();
    map.getCanvas().style.cursor = state.drawing ? 'crosshair' : '';
  };

  map.on('load', () => {
    const empty = { type: 'FeatureCollection' as const, features: [] };
    map.addSource('cov-packs', { type: 'geojson', data: empty });
    map.addSource('cov-draft', { type: 'geojson', data: empty });
    map.addLayer({
      id: 'cov-packs-fill',
      type: 'fill',
      source: 'cov-packs',
      paint: {
        'fill-color': ['case', ['get', 'hi'], c.hi, c.line],
        'fill-opacity': ['case', ['get', 'hi'], 0.25, 0.1],
      },
    });
    map.addLayer({
      id: 'cov-packs-line',
      type: 'line',
      source: 'cov-packs',
      paint: {
        'line-color': ['case', ['get', 'hi'], c.hi, c.line],
        'line-width': ['case', ['get', 'hi'], 2, 1],
      },
    });
    map.addLayer({
      id: 'cov-draft-fill',
      type: 'fill',
      source: 'cov-draft',
      paint: { 'fill-color': c.draft, 'fill-opacity': 0.18 },
    });
    map.addLayer({
      id: 'cov-draft-line',
      type: 'line',
      source: 'cov-draft',
      paint: { 'line-color': c.draft, 'line-width': 2, 'line-dasharray': [2, 1] },
    });
    loaded = true;
    push();
  });

  const down = (e: MapMouseEvent) => {
    if (!state.drawing) return;
    start = e.lngLat;
  };
  const move = (e: MapMouseEvent) => {
    if (!state.drawing || !start) return;
    const box = dragBbox(start, e.lngLat);
    if (box) {
      state = { ...state, draft: box };
      push();
    }
  };
  const up = (e: MapMouseEvent) => {
    if (!state.drawing || !start) return;
    const box = dragBbox(start, e.lngLat);
    start = null;
    if (box) onDraw(box);
  };
  map.on('mousedown', down);
  map.on('mousemove', move);
  map.on('mouseup', up);

  return {
    update(next: CoverageState) {
      if (next.packs !== state.packs) installBasemap(next.packs);
      state = next;
      push();
    },
    fit(bbox: Bbox) {
      // The panel beside the map may have just opened; measure before fitting.
      map.resize();
      map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        { padding: 24, maxZoom: 7, duration: 300 },
      );
    },
    resize() {
      map.resize();
    },
    dispose() {
      map.remove();
    },
  };
}

export type CoverageMap = ReturnType<typeof createCoverageMap>;
