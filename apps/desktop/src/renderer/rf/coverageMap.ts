/**
 * The coverage on the 2D map (spec D23, D23a): the view's picture as a MapLibre image source
 * placed through the frame projection, and each source's boresight as a thin arrow. Both go
 * above the project's rasters and the basemap imagery (`ABOVE_RASTERS`, under the controller's
 * own lines and the labels), so streets and names stay readable. The eye hides both; the opacity
 * is the layer's `raster-opacity`. Drawn again when the style reloads (a basemap switch), as the
 * hydrology overlay is.
 */
import { ABOVE_RASTERS } from '@aio/maps';

export const COVERAGE_SOURCE = 'aio-rf-coverage';
export const COVERAGE_LAYER = 'aio-rf-coverage';
export const BORESIGHT_SOURCE = 'aio-rf-boresight';
export const BORESIGHT_LAYER = 'aio-rf-boresight';

type LonLat = [number, number];

export interface CoverageMapDraw {
  /** The picture as an image URL (PNG data URL) and its corners tl, tr, br, bl; null: nothing. */
  image: { url: string; corners: [LonLat, LonLat, LonLat, LonLat] } | null;
  /** Boresight arrows as lon/lat polylines with a colour each. */
  arrows: { path: LonLat[]; colour: string }[];
  visible: boolean;
  opacity: number;
}

/** The slice of a MapLibre map this module drives (tests pass a fake). */
export interface CoverageMapLike {
  isStyleLoaded(): unknown;
  getSource(id: string): unknown;
  addSource(id: string, source: unknown): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: unknown, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  setPaintProperty(layer: string, name: string, value: unknown): unknown;
  setLayoutProperty(layer: string, name: string, value: unknown): unknown;
  on(type: string, fn: () => void): unknown;
  off(type: string, fn: () => void): unknown;
  once(type: string, fn: () => void): unknown;
}

export interface CoverageMapView {
  draw(d: CoverageMapDraw): void;
  dispose(): void;
}

const EMPTY = { type: 'FeatureCollection', features: [] };

/** The picture and where it lies: a moved grid (a new line-up shift) is placed again. */
const imageKey = (i: NonNullable<CoverageMapDraw['image']>): string =>
  `${i.url}|${i.corners.map((c) => c.join(',')).join(';')}`;

function arrowData(d: CoverageMapDraw) {
  return {
    type: 'FeatureCollection',
    features: d.arrows.map((a) => ({
      type: 'Feature',
      properties: { colour: a.colour },
      geometry: { type: 'LineString', coordinates: a.path },
    })),
  };
}

/** Draw the coverage on a map and keep it there across style reloads. Returns the view. */
export function attachCoverageMap(ctl: { map: CoverageMapLike }): CoverageMapView {
  const map = ctl.map;
  let last: CoverageMapDraw | null = null;
  let shownUrl: string | null = null;
  let disposed = false;
  let waiting = false;

  const before = () => (map.getLayer(ABOVE_RASTERS) ? ABOVE_RASTERS : undefined);

  function apply(): void {
    const d = last;
    if (!d || disposed) return;
    try {
      if (!map.isStyleLoaded()) {
        if (!waiting) {
          waiting = true;
          map.once('idle', () => {
            waiting = false;
            apply();
          });
        }
        return;
      }
      const vis = d.visible ? 'visible' : 'none';
      // the picture: replaced when it changes (a new run, view or preview)
      const has = map.getSource(COVERAGE_SOURCE) !== undefined;
      if (!d.image) {
        if (map.getLayer(COVERAGE_LAYER)) map.removeLayer(COVERAGE_LAYER);
        if (has) map.removeSource(COVERAGE_SOURCE);
        shownUrl = null;
      } else if (!has || shownUrl !== imageKey(d.image)) {
        const src = map.getSource(COVERAGE_SOURCE) as
          { updateImage?: (o: { url: string; coordinates: LonLat[] }) => unknown } | undefined;
        if (src?.updateImage) src.updateImage({ url: d.image.url, coordinates: d.image.corners });
        else
          map.addSource(COVERAGE_SOURCE, {
            type: 'image',
            url: d.image.url,
            coordinates: d.image.corners,
          });
        shownUrl = imageKey(d.image);
      }
      if (d.image && !map.getLayer(COVERAGE_LAYER))
        map.addLayer(
          {
            id: COVERAGE_LAYER,
            type: 'raster',
            source: COVERAGE_SOURCE,
            layout: { visibility: vis },
            paint: {
              'raster-opacity': d.opacity,
              'raster-fade-duration': 0,
              'raster-resampling': 'nearest',
            },
          },
          before(),
        );
      if (map.getLayer(COVERAGE_LAYER)) {
        map.setPaintProperty(COVERAGE_LAYER, 'raster-opacity', d.opacity);
        map.setLayoutProperty(COVERAGE_LAYER, 'visibility', vis);
      }
      // the boresight arrows, above the picture
      const data = d.arrows.length ? arrowData(d) : EMPTY;
      const arrows = map.getSource(BORESIGHT_SOURCE) as
        { setData?: (v: unknown) => unknown } | undefined;
      if (arrows?.setData) arrows.setData(data);
      else map.addSource(BORESIGHT_SOURCE, { type: 'geojson', data });
      if (!map.getLayer(BORESIGHT_LAYER))
        map.addLayer(
          {
            id: BORESIGHT_LAYER,
            type: 'line',
            source: BORESIGHT_SOURCE,
            layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
            paint: { 'line-color': ['get', 'colour'], 'line-width': 2 },
          },
          before(),
        );
      map.setLayoutProperty(BORESIGHT_LAYER, 'visibility', vis);
    } catch {
      // the style is being replaced: drawn again on its next load
    }
  }

  const onStyle = () => {
    // a new style dropped our sources: put them back
    if (map.getSource(COVERAGE_SOURCE) === undefined) shownUrl = null;
    apply();
  };
  map.on('styledata', onStyle);

  return {
    draw(d) {
      last = d;
      apply();
    },
    dispose() {
      disposed = true;
      map.off('styledata', onStyle);
      try {
        for (const id of [BORESIGHT_LAYER, COVERAGE_LAYER])
          if (map.getLayer(id)) map.removeLayer(id);
        for (const id of [BORESIGHT_SOURCE, COVERAGE_SOURCE])
          if (map.getSource(id) !== undefined) map.removeSource(id);
      } catch {
        // the map is going away
      }
    },
  };
}
