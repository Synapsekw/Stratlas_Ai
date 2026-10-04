import type { FeatureCollection, Polygon } from 'geojson';
import { normaliseBbox } from './estimate';
import type { Bbox, MapPack } from './packs';

export function bboxPolygon([w, s, e, n]: readonly number[]): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w ?? 0, s ?? 0],
        [e ?? 0, s ?? 0],
        [e ?? 0, n ?? 0],
        [w ?? 0, n ?? 0],
        [w ?? 0, s ?? 0],
      ],
    ],
  };
}

const isWorld = ([w = 0, s = 0, e = 0, n = 0]: readonly number[]) =>
  w <= -179.9 && e >= 179.9 && s <= -84 && n >= 84;

export interface CoverageFeatures {
  packs: FeatureCollection<Polygon, { id: string; label: string; hi: boolean }>;
  draft: FeatureCollection<Polygon>;
}

/** Outlines of the regional packs (the world pack covers everything, so it gets none). */
export function coverageFeatures(
  packs: readonly Pick<MapPack, 'id' | 'label' | 'bbox'>[],
  highlight: string | null = null,
  draft: Bbox | null = null,
): CoverageFeatures {
  return {
    packs: {
      type: 'FeatureCollection',
      features: packs
        .filter((p) => !isWorld(p.bbox))
        .map((p) => ({
          type: 'Feature',
          geometry: bboxPolygon(p.bbox),
          properties: { id: p.id, label: p.label, hi: p.id === highlight },
        })),
    },
    draft: {
      type: 'FeatureCollection',
      features: draft ? [{ type: 'Feature', geometry: bboxPolygon(draft), properties: {} }] : [],
    },
  };
}

/** The box between two dragged points, or null for a click without a drag. */
export function dragBbox(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): Bbox | null {
  if (Math.abs(a.lng - b.lng) < 1e-6 || Math.abs(a.lat - b.lat) < 1e-6) return null;
  return normaliseBbox([a.lng, a.lat, b.lng, b.lat]);
}
