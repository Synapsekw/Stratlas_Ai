import type { RasterPackInfo, RasterPackKind } from '@aio/schema';
import type {
  GetResourceResponse,
  HillshadeLayerSpecification,
  LayerSpecification,
  RasterDEMSourceSpecification,
  RasterLayerSpecification,
  RasterSourceSpecification,
  RequestParameters,
} from 'maplibre-gl';
import { orderPacks } from './packs';
import type { TileReader } from './protocol';

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

/** Where raster layers go: under the first line or label layer (streets and names on top). */
export function insertBefore(
  layers: readonly Pick<LayerSpecification, 'id' | 'type'>[],
): string | undefined {
  return layers.find((l) => l.type === 'line' || l.type === 'symbol')?.id;
}

/** The slice of a MapLibre map this module drives. */
export interface RasterMap {
  getStyle(): { layers?: Pick<LayerSpecification, 'id' | 'type'>[] } | undefined;
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
    const [{ addProtocol }, { FetchSource, PMTiles }] = await Promise.all([
      import('maplibre-gl'),
      import('pmtiles'),
    ]);
    const handler = createRasterProtocol(
      (kind, id) => new PMTiles(new FetchSource(`${packBase}${kind}/${id}.pmtiles`)),
    );
    addProtocol(RASTER_PROTOCOL, (params, abort) => handler(params, abort));
  })();
  return installed;
}
