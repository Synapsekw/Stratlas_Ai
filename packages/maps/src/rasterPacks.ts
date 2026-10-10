import { ONLINE_SATELLITE, type RasterPackInfo, type RasterPackKind } from '@aio/schema';
import type {
  GetResourceResponse,
  HillshadeLayerSpecification,
  LayerSpecification,
  RasterDEMSourceSpecification,
  RasterLayerSpecification,
  RasterSourceSpecification,
  RequestParameters,
} from 'maplibre-gl';
import { FetchSource, PMTiles } from 'pmtiles';
import { orderPacks } from './packs';
import type { TileReader } from './protocol';
import { BASEMAP_SOURCE } from './style';

/**
 * Imagery and terrain packs on the 2D map (M10 G7, decision 4): a **Satellite** basemap of the
 * installed imagery packs under the streets, and the terrain packs as a `raster-dem` hillshade.
 *
 * Each pack is its own source on the internal `aioraster://<kind>/<id>/{z}/{x}/{y}` protocol, read
 * from `aio://packs/<kind>/<id>.pmtiles` (served by main with range requests), with its bounds and
 * zoom range so MapLibre asks only for tiles the pack may hold. Layers go coarse to detailed, so a
 * customer's 30 cm image draws over the 10 m region pack over the world pack. The packs' licence
 * attributions show in the map's attribution control. Nothing here loads MapLibre: the protocol
 * is added by `installRasterProtocol` (a lazy import, browser only).
 */

export const RASTER_PROTOCOL = 'aioraster';
const PREFIX = 'g7-raster-';
export const HILLSHADE_LAYER = `${PREFIX}hillshade`;

type Pack = Pick<
  RasterPackInfo,
  'id' | 'kind' | 'bbox' | 'minZoom' | 'maxZoom' | 'tileSize' | 'attribution' | 'label'
>;

export function rasterSourceId(pack: Pick<Pack, 'id' | 'kind'>): string {
  return `${PREFIX}${pack.kind}-${pack.id}`;
}

export function rasterTileUrl(pack: Pick<Pack, 'id' | 'kind'>): string {
  if (!/^[a-z0-9-]+$/.test(pack.id)) throw new Error(`Invalid pack id "${pack.id}"`);
  return `${RASTER_PROTOCOL}://${pack.kind}/${pack.id}/{z}/{x}/{y}`;
}

const bounds = (b: readonly number[]): [number, number, number, number] => [
  Math.max(-180, b[0] ?? -180),
  Math.max(-85.0511, b[1] ?? -85.0511),
  Math.min(180, b[2] ?? 180),
  Math.min(85.0511, b[3] ?? 85.0511),
];

export function imagerySource(pack: Pack): RasterSourceSpecification {
  return {
    type: 'raster',
    tiles: [rasterTileUrl(pack)],
    tileSize: pack.tileSize,
    minzoom: pack.minZoom,
    maxzoom: pack.maxZoom,
    bounds: bounds(pack.bbox),
    attribution: pack.attribution,
  };
}

export function terrainSource(pack: Pack): RasterDEMSourceSpecification {
  return {
    type: 'raster-dem',
    tiles: [rasterTileUrl(pack)],
    tileSize: pack.tileSize,
    minzoom: pack.minZoom,
    maxzoom: pack.maxZoom,
    bounds: bounds(pack.bbox),
    encoding: 'terrarium',
    attribution: pack.attribution,
  };
}

/** Raster layers for the imagery packs, coarse first (drawn first, so under the detailed ones). */
export function satelliteLayers(packs: readonly Pack[]): RasterLayerSpecification[] {
  const imagery = orderPacks(packs.filter((p) => p.kind === 'imagery')).reverse();
  return imagery.map((p) => ({
    id: `${rasterSourceId(p)}-layer`,
    type: 'raster',
    source: rasterSourceId(p),
    paint: { 'raster-fade-duration': 0 },
  }));
}

export function hillshadeLayer(pack: Pack): HillshadeLayerSpecification {
  return {
    id: HILLSHADE_LAYER,
    type: 'hillshade',
    source: rasterSourceId(pack),
    paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': 'rgba(0,0,0,0.55)' },
  };
}

/**
 * Online satellite (ADR 0007, amendment of 10 Oct 2026): Sentinel-2 cloudless 2016, streamed by
 * main through `aio://online/...` while the person has it switched on. The description
 * (`ONLINE_SATELLITE` in `@aio/schema`) names no server; the source carries the credit the licence
 * asks for, so the map's attribution control shows it while the layer is on.
 */
export const ONLINE_SATELLITE_SOURCE = `${PREFIX}online-${ONLINE_SATELLITE.id}`;
export const ONLINE_SATELLITE_LAYER = `${ONLINE_SATELLITE_SOURCE}-layer`;

export function onlineSatelliteSource(): RasterSourceSpecification {
  return {
    type: 'raster',
    tiles: [ONLINE_SATELLITE.tileUrl],
    tileSize: ONLINE_SATELLITE.tileSize,
    minzoom: ONLINE_SATELLITE.minZoom,
    // the imagery's own detail: a closer view stretches these tiles, no deeper one is asked for
    maxzoom: ONLINE_SATELLITE.maxZoom,
    attribution: ONLINE_SATELLITE.attribution,
  };
}

export function onlineSatelliteLayer(): RasterLayerSpecification {
  return {
    id: ONLINE_SATELLITE_LAYER,
    type: 'raster',
    source: ONLINE_SATELLITE_SOURCE,
    paint: { 'raster-fade-duration': 0 },
  };
}

/** Where raster layers go: under the first line or label layer (streets and names on top). */
export function insertBefore(
  layers: readonly Pick<LayerSpecification, 'id' | 'type'>[],
): string | undefined {
  return layers.find((l) => l.type === 'line' || l.type === 'symbol')?.id;
}

/** A layer of a style as this module reads it. */
type StyleLayer = Pick<LayerSpecification, 'id' | 'type'> & { source?: unknown };

/** The slice of a MapLibre map this module drives. */
export interface RasterMap {
  getStyle(): { layers?: StyleLayer[]; sources?: Record<string, unknown> } | undefined;
  getSource(id: string): unknown;
  addSource(id: string, source: RasterSourceSpecification | RasterDEMSourceSpecification): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: LayerSpecification, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
}

export interface RasterPackDisplay {
  imagery: readonly Pack[];
  terrain: readonly Pack[];
  /** Show the imagery packs (the Satellite basemap). */
  satellite: boolean;
  /** Shade the relief of the most detailed terrain pack. */
  hillshade: boolean;
  /**
   * Draw the online satellite imagery at the bottom of the stack: under the imagery packs (which
   * are sharper and win where they have tiles) and under the project's own orthos.
   */
  online?: boolean;
}

/**
 * Add the packs' sources and layers to a map (idempotent); returns a function that removes them.
 * Call again after a style reload.
 */
export function applyRasterPacks(map: RasterMap, d: RasterPackDisplay): () => void {
  const added: { layers: string[]; sources: string[] } = { layers: [], sources: [] };
  const before = insertBefore(map.getStyle()?.layers ?? []);
  const addSource = (id: string, s: RasterSourceSpecification | RasterDEMSourceSpecification) => {
    if (map.getSource(id)) return;
    map.addSource(id, s);
    added.sources.push(id);
  };
  const addLayer = (l: LayerSpecification) => {
    if (map.getLayer(l.id)) return;
    map.addLayer(l, before);
    added.layers.push(l.id);
  };
  if (d.online) {
    // first, so every pack layer added below draws over it
    addSource(ONLINE_SATELLITE_SOURCE, onlineSatelliteSource());
    addLayer(onlineSatelliteLayer());
  }
  if (d.satellite) {
    for (const p of d.imagery) addSource(rasterSourceId(p), imagerySource(p));
    for (const l of satelliteLayers(d.imagery)) addLayer(l);
  }
  const dem = orderPacks(d.terrain.filter((p) => p.kind === 'terrain'))[0];
  if (d.hillshade && dem) {
    addSource(rasterSourceId(dem), terrainSource(dem));
    addLayer(hillshadeLayer(dem));
  }
  return () => {
    for (const id of added.layers.reverse()) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of added.sources) if (map.getSource(id)) map.removeSource(id);
  };
}

/**
 * Bring a map's pack sources and layers to `d`, touching only what differs: a pack already on the
 * map keeps its source, its layer and the tiles it has drawn. Switching the basemap (Streets,
 * Satellite, one pack or all of them) or the hillshade therefore never blanks what stays on
 * screen, where removing everything and adding it again would. Layers keep their order: imagery
 * coarse to detailed, the hillshade over it, all of it under the streets. Throws while the style
 * is loading (as MapLibre does): call again on the next style event, and after a style reload.
 */
export function syncRasterPacks(map: RasterMap, d: RasterPackDisplay): void {
  const sources = new Map<string, RasterSourceSpecification | RasterDEMSourceSpecification>();
  /** Bottom to top. */
  const layers: (RasterLayerSpecification | HillshadeLayerSpecification)[] = [];
  if (d.online) {
    // the bottom of the stack: every pack layer draws over it
    sources.set(ONLINE_SATELLITE_SOURCE, onlineSatelliteSource());
    layers.push(onlineSatelliteLayer());
  }
  if (d.satellite) {
    const imagery = d.imagery.filter((p) => p.kind === 'imagery');
    for (const p of imagery) sources.set(rasterSourceId(p), imagerySource(p));
    layers.push(...satelliteLayers(imagery));
  }
  const dem = orderPacks(d.terrain.filter((p) => p.kind === 'terrain'))[0];
  if (d.hillshade && dem) {
    sources.set(rasterSourceId(dem), terrainSource(dem));
    layers.push(hillshadeLayer(dem));
  }
  const style = map.getStyle();
  const present = style?.layers ?? [];
  const wanted = new Map(layers.map((l) => [l.id, l.source]));
  // a layer whose pack changed (the hillshade of another terrain pack) goes and comes back
  for (const l of present)
    if (l.id.startsWith(PREFIX) && wanted.get(l.id) !== l.source) map.removeLayer(l.id);
  for (const id of Object.keys(style?.sources ?? {}))
    if (id.startsWith(PREFIX) && !sources.has(id)) map.removeSource(id);
  for (const [id, source] of sources) if (!map.getSource(id)) map.addSource(id, source);
  // top down, each under the one above it, so a pack added later lands in its place
  let above = insertBefore(present.filter((l) => !l.id.startsWith(PREFIX)));
  for (const l of [...layers].reverse()) {
    if (!map.getLayer(l.id)) map.addLayer(l, above);
    above = l.id;
  }
}

/** The slice of a MapLibre map `setStreetOverlay` drives. */
export interface StreetOverlayMap {
  getStyle(): { layers?: StyleLayer[] } | undefined;
  setLayoutProperty(layer: string, name: 'visibility', value: 'visible' | 'none'): unknown;
}

/**
 * Show or hide the streets and names the basemap draws over the imagery (Satellite only hides
 * them). The land and water under the imagery stay, so the map is never empty where no pack
 * reaches, and the project's own layers (orthos, flights, issues) are not basemap layers and stay
 * too. Returns the ids it set. Throws while the style is loading, as MapLibre does.
 */
export function setStreetOverlay(map: StreetOverlayMap, visible: boolean): string[] {
  const layers = map.getStyle()?.layers ?? [];
  const first = layers.findIndex((l) => l.type === 'line' || l.type === 'symbol');
  if (first < 0) return [];
  const ids = layers
    .slice(first)
    .filter((l) => l.source === BASEMAP_SOURCE)
    .map((l) => l.id);
  for (const id of ids) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  return ids;
}

/** A transparent 1 x 1 PNG for an imagery tile no pack holds (a missing tile is not an error). */
const EMPTY_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

export type RasterProtocolHandler = (
  params: Pick<RequestParameters, 'url'>,
  abort: AbortController,
) => Promise<GetResourceResponse<ArrayBuffer>>;

/** The `aioraster://` handler over pack readers (one per pack, opened on first use). */
export function createRasterProtocol(
  open: (kind: RasterPackKind, id: string) => TileReader,
): RasterProtocolHandler {
  const readers = new Map<string, TileReader>();
  return async ({ url }, abort) => {
    const m = /^aioraster:\/\/(imagery|terrain)\/([a-z0-9-]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
    if (!m) throw new Error(`Bad raster tile URL ${url}`);
    const kind = m[1] as RasterPackKind;
    const id = m[2] ?? '';
    const key = `${kind}/${id}`;
    let r = readers.get(key);
    if (!r) {
      r = open(kind, id);
      readers.set(key, r);
    }
    const tile = await r.getZxy(Number(m[3]), Number(m[4]), Number(m[5]), abort.signal);
    if (tile && tile.data.byteLength > 0) return { data: tile.data };
    if (kind === 'imagery') return { data: EMPTY_PNG.slice().buffer };
    // a terrain tile no pack holds: MapLibre skips it (the hillshade has a hole there)
    throw new Error('No terrain tile');
  };
}

let installed: Promise<void> | null = null;

/** Register `aioraster://` with MapLibre once (browser only), reading `aio://packs/`. */
export function installRasterProtocol(packBase = 'aio://packs/'): Promise<void> {
  installed ??= (async () => {
    const { addProtocol } = await import('maplibre-gl');
    const handler = createRasterProtocol(
      (kind, id) => new PMTiles(new FetchSource(`${packBase}${kind}/${id}.pmtiles`)),
    );
    addProtocol(RASTER_PROTOCOL, (params, abort) => handler(params, abort));
  })();
  return installed;
}
