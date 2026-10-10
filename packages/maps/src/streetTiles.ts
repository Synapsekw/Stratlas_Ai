// Browser-only: the street map as raster tiles, for the Globe. One hidden MapLibre map draws the
// app's street style (the installed street packs, the bundled glyphs and sprites) for one Web
// Mercator tile at a time and hands back a copy of the picture; CesiumJS drapes it on the Earth.
// The same offline path as the Map view and the 3D ground (`groundRender.ts`): nothing here can
// reach the network.
//
// Three things differ from a map on screen:
// - no background layer, so a tile is transparent where no pack has data and the Globe's own
//   land and water show through in the same colours;
// - a tile no pack holds answers "not found" instead of "empty", so MapLibre keeps drawing the
//   coarser tile above it (the world overview under a street pack that ends, a pack drawn past
//   its deepest zoom);
// - each tile is drawn with a margin and cropped, so a label that crosses a tile edge is placed
//   the same way in both tiles.
import { AJAXError, Map as MapLibreMap, addProtocol, type StyleSpecification } from 'maplibre-gl';
import type { MapPack } from './packs';
import { tileBbox } from './packs';
import { basemapResource, installBasemap } from './runtime';
import { streetCover, type StreetCover } from './streetCover';
import { BASEMAP_SOURCE, MAP_PROTOCOL, buildStyle } from './style';

/** The street tiles' own protocol: the basemap's tiles, with "not found" for a missing tile. */
export const STREET_TILE_PROTOCOL = 'aioglobe';
/** A street tile's edge in CSS pixels: MapLibre's own tile size, so labels keep their size. */
export const STREET_TILE_SIZE = 512;
/** Drawn around each tile and cropped away, CSS pixels. */
const MARGIN = 128;
/** A tile that is not drawn after this long is handed over as it is. */
const IDLE_TIMEOUT_MS = 8000;

export interface StreetTileStats {
  tiles: number;
  skipped: number;
  deferred: number;
  /** Tiles handed over before MapLibre said it was done. */
  timeouts: number;
  meanMs: number;
  maxMs: number;
  lastMs: number;
  /** Of `meanMs`: waiting for MapLibre to read and draw the tile, and copying the picture. */
  drawMs: number;
  copyMs: number;
  imagePx: number;
  /** The last thing MapLibre reported as an error, if any. */
  lastError: string | null;
}

export interface StreetTiles {
  readonly tileSize: number;
  /** The deepest level any pack is drawn at. */
  readonly maxZoom: number;
  readonly credit: string;
  /**
   * Tile `z/x/y`. `undefined`: a tile is being drawn, ask again shortly. `null`: no pack reaches
   * this tile at this level.
   */
  request(z: number, x: number, y: number): Promise<HTMLCanvasElement | null> | undefined;
  stats(): StreetTileStats;
  dispose(): void;
}

export interface StreetTileOptions {
  /** Device pixels per CSS pixel of the pictures (1 to 2). */
  pixelRatio?: number;
  lang?: 'en' | 'ar';
}

let protocolInstalled = false;
function installStreetProtocol(): void {
  if (protocolInstalled) return;
  protocolInstalled = true;
  addProtocol(STREET_TILE_PROTOCOL, async (params, abort) => {
    const url = `${MAP_PROTOCOL}${params.url.slice(STREET_TILE_PROTOCOL.length)}`;
    const answer = await basemapResource({ ...params, url }, abort);
    const data: unknown = answer.data;
    if (data instanceof ArrayBuffer && data.byteLength === 0)
      throw new AJAXError(404, 'Not Found', params.url, new Blob());
    return answer;
  });
}

/** The street style for tiles: no background, tiles through the street tile protocol. */
export function streetTileStyle(lang: 'en' | 'ar', maxZoom: number): StyleSpecification {
  const style = buildStyle({ lang, maxZoom });
  const source = style.sources[BASEMAP_SOURCE];
  return {
    ...style,
    sources: {
      ...style.sources,
      ...(source?.type === 'vector'
        ? {
            [BASEMAP_SOURCE]: {
              ...source,
              tiles: [`${STREET_TILE_PROTOCOL}://tiles/{z}/{x}/{y}`],
            },
          }
        : {}),
    },
    layers: style.layers.filter((l) => l.type !== 'background'),
  };
}

/** Latitude of the middle of tile row `y` at zoom `z` in Web Mercator. */
function midLatitude(z: number, y: number): number {
  const n = Math.PI * (1 - (2 * (y + 0.5)) / 2 ** z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** Street tiles from the installed street packs, or null without any. */
export function createStreetTiles(
  packs: readonly MapPack[],
  options: StreetTileOptions = {},
): StreetTiles | null {
  const cover: StreetCover = streetCover(packs);
  if (packs.length === 0 || cover.maxZoom < 0) return null;
  const ratio = Math.max(1, Math.min(2, options.pixelRatio ?? 1));
  const out = Math.round(STREET_TILE_SIZE * ratio);
  const view = STREET_TILE_SIZE + 2 * MARGIN;
  const stats: StreetTileStats = {
    tiles: 0,
    skipped: 0,
    deferred: 0,
    timeouts: 0,
    meanMs: 0,
    maxMs: 0,
    lastMs: 0,
    drawMs: 0,
    copyMs: 0,
    imagePx: out,
    lastError: null,
  };
  let host: HTMLDivElement | null = null;
  let map: MapLibreMap | null = null;
  let ready: Promise<void> | null = null;
  const state = { busy: false, disposed: false };
  /** Asked again after every wait: `dispose` may run while a tile is being drawn. */
  const gone = (): boolean => state.disposed;

  const start = (): Promise<void> => {
    if (ready) return ready;
    installBasemap(packs);
    installStreetProtocol();
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    host.style.cssText = `position:fixed;left:-${String(view * 2)}px;top:0;width:${String(view)}px;height:${String(view)}px;pointer-events:none;contain:strict`;
    document.body.appendChild(host);
    const m = new MapLibreMap({
      container: host,
      style: streetTileStyle(options.lang ?? 'en', Math.max(...packs.map((p) => p.maxZoom))),
      center: [0, 0],
      zoom: 1,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: ratio,
      maxZoom: 22,
      // tiles are drawn one after another around the same places: keep what was read
      maxTileCacheSize: 256,
      renderWorldCopies: true,
      validateStyle: false,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    // a tile no pack holds is expected; anything else is kept for the inspection hook
    m.on('error', (e) => {
      stats.lastError = e.error.message;
    });
    map = m;
    ready = new Promise((resolve) => {
      const timer = setTimeout(resolve, IDLE_TIMEOUT_MS);
      void m.once('load').then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return ready;
  };

  /** Resolves when everything for the current view is drawn; false after the timeout. */
  const idle = (m: MapLibreMap): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, IDLE_TIMEOUT_MS);
      void m.once('idle').then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  const draw = async (z: number, x: number, y: number): Promise<HTMLCanvasElement | null> => {
    await start();
    const m = map;
    if (!m || gone()) return null;
    const [west, south, east, north] = tileBbox(z, x, y);
    const t0 = performance.now();
    m.jumpTo({ center: [(west + east) / 2, midLatitude(z, y)], zoom: z, bearing: 0, pitch: 0 });
    m.triggerRepaint();
    if (!(await idle(m))) stats.timeouts++;
    if (gone()) return null;
    const t1 = performance.now();
    // where the tile landed: MapLibre keeps the view inside the poles, so the first rows of
    // tiles are not centred, and the whole world at zoom 0 is drawn a little larger
    const a = m.project([west, north]);
    const b = m.project([east, south]);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const source = m.getCanvas();
    const k = source.width / view;
    ctx.drawImage(source, a.x * k, a.y * k, (b.x - a.x) * k, (b.y - a.y) * k, 0, 0, out, out);
    const n = stats.tiles + 1;
    stats.drawMs += (t1 - t0 - stats.drawMs) / n;
    stats.copyMs += (performance.now() - t1 - stats.copyMs) / n;
    return canvas;
  };

  return {
    tileSize: STREET_TILE_SIZE,
    maxZoom: cover.maxZoom,
    credit: '© OpenStreetMap contributors',
    request(z, x, y) {
      if (state.disposed || !cover.has(z, x, y)) {
        stats.skipped++;
        return Promise.resolve(null);
      }
      if (state.busy) {
        stats.deferred++;
        return undefined;
      }
      state.busy = true;
      const t0 = performance.now();
      return draw(z, x, y).finally(() => {
        state.busy = false;
        const ms = performance.now() - t0;
        stats.tiles++;
        stats.lastMs = ms;
        stats.maxMs = Math.max(stats.maxMs, ms);
        stats.meanMs += (ms - stats.meanMs) / stats.tiles;
      });
    },
    stats: () => ({ ...stats }),
    dispose() {
      state.disposed = true;
      map?.remove();
      host?.remove();
      map = null;
      host = null;
    },
  };
}
