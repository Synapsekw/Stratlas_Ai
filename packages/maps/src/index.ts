/** An installed offline map pack (PMTiles). */
export interface MapPack {
  id: string;
  label: string;
  /** [west, south, east, north] in degrees. */
  bbox: [number, number, number, number];
  maxZoom: number;
  sizeBytes: number;
}

/** MapLibre source URL for a pack served by the main process over aio://. */
export function packUrl(pack: Pick<MapPack, 'id'>): string {
  if (!/^[a-z0-9-]+$/.test(pack.id)) throw new Error(`Invalid map pack id "${pack.id}"`);
  return `pmtiles://aio://packs/${pack.id}.pmtiles`;
}

/** True when the point lies inside the pack bounding box. */
export function packCovers(pack: Pick<MapPack, 'bbox'>, lon: number, lat: number): boolean {
  const [w, s, e, n] = pack.bbox;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}
export { MapView, type MapViewProps } from './MapView';

/** Registers basemap and raster ground adapters with @aio/engine. Owner: stream S5. Phase 0: no-op. */
export function registerMapAdapters(): void {
  /* implemented by stream S5 */
}
