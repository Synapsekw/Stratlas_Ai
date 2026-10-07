import { correctedPhoto, photoCorrection } from '@aio/geo';
import type { Workspace } from '@aio/workspace';
import type { Feature, FeatureCollection } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FrameProjection } from './geo';
import { MAP_INK } from './ink';

/*
 * Where photos were taken, as pins on the map (clustered): placed with their hand corrections
 * (orientation.json), selectable, and what the photo right-click menu finds.
 */

export const PHOTO_SOURCE = 'aio-photos';
/** The pin and cluster layers (clicks, right-clicks, the pointer cursor). */
export const PHOTO_PIN_LAYERS = ['aio-photos-pt', 'aio-photos-cluster'] as const;

const INK = MAP_INK;

/** The clustered photo source and its layers (call once the style has loaded). */
export function addPhotoPins(map: MapLibreMap, before?: string): void {
  map.addSource(PHOTO_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    cluster: true,
    clusterRadius: 32,
    clusterMaxZoom: 20,
  });
  map.addLayer(
    {
      id: 'aio-photos-cluster',
      type: 'circle',
      source: PHOTO_SOURCE,
      filter: ['has', 'point_count'],
      paint: {
        'circle-radius': ['step', ['get', 'point_count'], 9, 10, 11, 50, 14],
        'circle-color': INK.bg0,
        'circle-stroke-color': INK.fg1,
        'circle-stroke-width': 1.5,
      },
    },
    before,
  );
  map.addLayer(
    {
      id: 'aio-photos-count',
      type: 'symbol',
      source: PHOTO_SOURCE,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': ['Noto Sans Medium'],
        'text-size': 10,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': INK.fg0 },
    },
    before,
  );
  map.addLayer(
    {
      id: 'aio-photos-pt',
      type: 'circle',
      source: PHOTO_SOURCE,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 6, 4.5],
        'circle-color': ['case', ['get', 'selected'], INK.accStrong, INK.bg0],
        'circle-stroke-color': INK.fg1,
        'circle-stroke-width': 1.5,
      },
    },
    before,
  );
}

/** The photos of the visible photo sets where their (corrected) cameras were. */
function placed(
  s: Workspace,
  proj: FrameProjection,
): { layer: string; id: string; at: [number, number] }[] {
  const out: { layer: string; id: string; at: [number, number] }[] = [];
  for (const l of s.project?.manifest.layers ?? []) {
    if (l.kind !== 'photos' || s.hidden[l.id]) continue;
    for (const item of l.items) {
      const c = correctedPhoto(item, photoCorrection(s.orientation, l.id, item.id));
      if (c.pos) out.push({ layer: l.id, id: item.id, at: proj.toLonLat(c.pos) });
    }
  }
  return out;
}

/** The pins: one point per placed photo, the selected one marked. */
export function photoPinData(s: Workspace, proj: FrameProjection): FeatureCollection {
  const sel = s.selection?.kind === 'photo' ? s.selection : null;
  const features: Feature[] = placed(s, proj).map((p) => ({
    type: 'Feature',
    properties: {
      photoLayer: p.layer,
      photoId: p.id,
      selected: sel?.id === p.id && (sel.layer === undefined || sel.layer === p.layer),
    },
    geometry: { type: 'Point', coordinates: p.at },
  }));
  return { type: 'FeatureCollection', features };
}

/** Where the photos are, for framing the project. */
export function photoPoints(s: Workspace, proj: FrameProjection): [number, number][] {
  return placed(s, proj).map((p) => p.at);
}
