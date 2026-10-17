import type { Vec3 } from '@aio/schema';
import type { Feature, FeatureCollection, Point } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MAP_INK } from './ink';

/*
 * Heading arrows of pinned photos and 360s on the map: a small arrowhead just ahead of the item's
 * marker plate, turned to the pin's heading (degrees clockwise from grid north) and turning with
 * the map. Pins without a heading draw no arrow; the plates themselves come from `mediaMarkers.ts`.
 */

export interface MapPin {
  id: string;
  kind: 'photo' | 'pano';
  ground: Vec3;
  headingDeg?: number;
}

const SOURCE = 'aio-media-pins';
const ARROW = 'aio-media-pin-arrow';
export const MEDIA_PIN_LAYERS = [ARROW] as const;

/** The arrow image: drawn at twice its map size. */
const PX = 40;
const RATIO = 2;

/** One point per pin at its ground point; `heading` only when the pin has one. */
export function mediaPinData(
  pins: readonly MapPin[],
  toLonLat: (p: Vec3) => [number, number],
): FeatureCollection<Point> {
  const features: Feature<Point>[] = pins.map((p) => ({
    type: 'Feature',
    properties: {
      id: p.id,
      kind: p.kind,
      ...(p.headingDeg !== undefined ? { heading: p.headingDeg } : {}),
    },
    geometry: { type: 'Point', coordinates: toLonLat(p.ground) },
  }));
  return { type: 'FeatureCollection', features };
}

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Whether (x, y) lies inside the polygon (even-odd). */
function inside(poly: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (!a || !b) continue;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
      hit = !hit;
  }
  return hit;
}

/** Distance from (x, y) to the polygon's outline. */
function edgeDistance(poly: readonly (readonly [number, number])[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (!a || !b) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)));
  }
  return best;
}

/**
 * An arrowhead pointing up (north before rotation): jade, with a thin dark rim outside it so it
 * reads on light ground too, as raw pixels (no 2D canvas needed); four samples a pixel smooth its
 * edges.
 */
function arrowImage(): { width: number; height: number; data: Uint8Array } {
  const head: [number, number][] = [
    [20, 4],
    [33, 34],
    [20, 27],
    [7, 34],
  ];
  const fill = rgb(MAP_INK.accStrong);
  const rim = rgb(MAP_INK.bg0);
  const data = new Uint8Array(PX * PX * 4);
  const subs = [0.25, 0.75];
  for (let y = 0; y < PX; y++)
    for (let x = 0; x < PX; x++) {
      let nf = 0;
      let nr = 0;
      for (const sy of subs)
        for (const sx of subs) {
          const px = x + sx;
          const py = y + sy;
          if (inside(head, px, py)) {
            nf++;
          } else if (edgeDistance(head, px, py) <= 1.6) nr++;
        }
      const n = nf + nr;
      if (!n) continue;
      const k = (y * PX + x) * 4;
      for (let c = 0; c < 3; c++)
        data[k + c] = Math.round(((fill[c] ?? 0) * nf + (rim[c] ?? 0) * nr) / n);
      data[k + 3] = Math.round((255 * n) / 4);
    }
  return { width: PX, height: PX, data };
}

/** Show these arrows: adds the source, its image and its layer once, then replaces the data. */
export function setMediaPins(map: MapLibreMap, data: FeatureCollection<Point>): void {
  const src = map.getSource(SOURCE) as { setData(d: FeatureCollection): unknown } | undefined;
  if (src) {
    void src.setData(data);
    return;
  }
  if (!map.hasImage(ARROW)) map.addImage(ARROW, arrowImage(), { pixelRatio: RATIO });
  map.addSource(SOURCE, { type: 'geojson', data });
  map.addLayer({
    id: ARROW,
    type: 'symbol',
    source: SOURCE,
    filter: ['has', 'heading'],
    layout: {
      'icon-image': ARROW,
      'icon-rotate': ['get', 'heading'],
      'icon-rotation-alignment': 'map',
      // ahead of the 18 px plate, in the heading's direction (the offset turns with the icon)
      'icon-offset': [0, -21],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
}

/** Take the arrows off the map. */
export function removeMediaPins(map: MapLibreMap): void {
  if (map.getLayer(ARROW)) map.removeLayer(ARROW);
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
  if (map.hasImage(ARROW)) map.removeImage(ARROW);
}
