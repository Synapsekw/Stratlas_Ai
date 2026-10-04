// Browser-only: a small offline map that reports clicks as longitude and latitude (new project
// origin, georeference targets). Loaded lazily by LocationPicker.
import type { FeatureCollection } from 'geojson';
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
} from 'maplibre-gl';
import { orderPacks, type MapPack } from './packs';
import { installBasemap } from './runtime';
import { buildStyle } from './style';

export interface PickerOptions {
  packs: readonly MapPack[];
  /** Start view; default the most detailed pack. */
  center?: [number, number];
  zoom?: number;
  onPick(lngLat: [number, number]): void;
}

export interface PickerController {
  /** Points drawn on the map (numbered in order), the last one highlighted. */
  setPoints(points: readonly [number, number][]): void;
  flyTo(center: [number, number], zoom?: number): void;
  resize(): void;
  dispose(): void;
}

const ACC = '#60d3b2';
const BG = '#080a0d';

export function createLocationPicker(el: HTMLElement, o: PickerOptions): PickerController {
  installBasemap(o.packs);
  const ordered = orderPacks(o.packs);
  const home = ordered.find((p) => p.maxZoom > 6) ?? ordered[0];
  const box = home?.bbox ?? [-180, -85, 180, 85];
  const maxZoom = Math.max(6, ...o.packs.map((p) => p.maxZoom));
  const map = new MapLibreMap({
    container: el,
    style: buildStyle({ lang: 'en', maxZoom }),
    ...(o.center
      ? { center: o.center, zoom: o.zoom ?? 14 }
      : {
          bounds: [
            [box[0], box[1]],
            [box[2], box[3]],
          ] as [[number, number], [number, number]],
        }),
    maxZoom: 20,
    renderWorldCopies: false,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.getCanvas().style.cursor = 'crosshair';
  let points: readonly [number, number][] = [];
  const data = (): FeatureCollection => ({
    type: 'FeatureCollection',
    features: points.map((p, i) => ({
      type: 'Feature',
      properties: { n: String(i + 1), last: i === points.length - 1 },
      geometry: { type: 'Point', coordinates: [...p] },
    })),
  });
  map.on('load', () => {
    map.addSource('aio-pick', { type: 'geojson', data: data() });
    map.addLayer({
      id: 'aio-pick-dot',
      type: 'circle',
      source: 'aio-pick',
      paint: {
        'circle-radius': ['case', ['get', 'last'], 7, 5],
        'circle-color': ACC,
        'circle-stroke-color': BG,
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'aio-pick-label',
      type: 'symbol',
      source: 'aio-pick',
      layout: {
        'text-field': ['get', 'n'],
        'text-font': ['Noto Sans Medium'],
        'text-size': 11,
        'text-offset': [0, -1.4],
      },
      paint: { 'text-color': '#eaedf1', 'text-halo-color': BG, 'text-halo-width': 1.5 },
    });
  });
  map.on('click', (e) => {
    o.onPick([e.lngLat.lng, e.lngLat.lat]);
  });
  return {
    setPoints(p) {
      points = p;
      void map.getSource<GeoJSONSource>('aio-pick')?.setData(data());
    },
    flyTo(center, zoom) {
      map.jumpTo({ center, ...(zoom !== undefined ? { zoom } : {}) });
    },
    resize() {
      map.resize();
    },
    dispose() {
      map.remove();
    },
  };
}
