import { correctedPhoto, photoCorrection } from '@aio/geo';
import { shiftLocal } from '@aio/schema';
import { dateShiftOf, type Workspace } from '@aio/workspace';
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
    const shift = s.project ? dateShiftOf(s.project.manifest, l.id) : null;
    for (const item of l.items) {
      const c = correctedPhoto(item, photoCorrection(s.orientation, l.id, item.id));
      // the date's line-up comes after the hand correction
      if (c.pos)
        out.push({ layer: l.id, id: item.id, at: proj.toLonLat(shiftLocal(c.pos, shift)) });
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

export interface PhotoMapPin {
  layerId: string;
  photoId: string;
}

/** A plain click on the photo pins: one photo, or the photos inside a cluster. */
export type PhotoMapClick =
  | ({ kind: 'pin' } & PhotoMapPin)
  | { kind: 'cluster'; x: number; y: number; photos: PhotoMapPin[] };

type PhotoMapClickHandler = (hit: PhotoMapClick) => void;

let onPhotoMapClick: PhotoMapClickHandler | null = null;

/**
 * The app opens a clicked map photo (a pin, or a row of a cluster's list). Unset: a pin is
 * selected and a cluster zooms until it splits.
 */
export function setPhotoMapClickHandler(handler: PhotoMapClickHandler | null): void {
  onPhotoMapClick = handler;
}

export function photoMapClickHandler(): PhotoMapClickHandler | null {
  return onPhotoMapClick;
}

/** The photos named on cluster leaves (MapLibre's getClusterLeaves). */
export function photosFromClusterLeaves(
  leaves: readonly { properties?: { photoLayer?: string; photoId?: string } | null }[],
): PhotoMapPin[] {
  const out: PhotoMapPin[] = [];
  for (const leaf of leaves) {
    const p = leaf.properties;
    if (p?.photoLayer && p.photoId) out.push({ layerId: p.photoLayer, photoId: p.photoId });
  }
  return out;
}
