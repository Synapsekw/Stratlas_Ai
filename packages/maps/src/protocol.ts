import type { GetResourceResponse, RequestParameters } from 'maplibre-gl';
import { orderPacks, packsForTile, type MapPack } from './packs';
import { MAP_PROTOCOL } from './style';

/** The slice of a PMTiles archive the protocol needs (pmtiles `PMTiles.getZxy`). */
export interface TileReader {
  getZxy(
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<{ data: ArrayBuffer } | undefined>;
}

/** Bundled asset loaders keyed by path under packages/maps/assets (e.g. `sprites/dark.json`). */
export type AssetLoaders = Record<string, () => Promise<ArrayBuffer>>;

export interface MapProtocolOptions {
  packs: readonly MapPack[];
  openPack(pack: MapPack): TileReader;
  assets: AssetLoaders;
}

export type MapProtocolHandler = (
  params: Pick<RequestParameters, 'url' | 'type'>,
  abort: AbortController,
) => Promise<GetResourceResponse<ArrayBuffer | object>>;

const EMPTY = new ArrayBuffer(0);

/**
 * Handler for the internal `aiomap://` protocol:
 * - `aiomap://tiles/{z}/{x}/{y}`: one merged vector source over every installed pack (world below
 *   its maxZoom, regional street packs above), read from aio://packs/<id>.pmtiles;
 * - `aiomap://glyphs/{fontstack}/{range}.pbf` and `aiomap://sprites/<name>[@2x].{json,png}`: files
 *   bundled with the app. Missing glyph ranges resolve empty so labels degrade, never error.
 */
export function createMapProtocol(options: MapProtocolOptions): MapProtocolHandler {
  const { packs, assets } = options;
  const ordered = orderPacks(packs);
  const readers = new Map<string, TileReader>();
  const reader = (p: MapPack): TileReader => {
    let r = readers.get(p.id);
    if (!r) {
      r = options.openPack(p);
      readers.set(p.id, r);
    }
    return r;
  };

  return async ({ url, type }, abort) => {
    const path = url.slice(`${MAP_PROTOCOL}://`.length);
    const [kind = '', ...rest] = path.split('/');

    if (kind === 'tiles') {
      const [z = NaN, x = NaN, y = NaN] = rest.map(Number);
      if (![z, x, y].every(Number.isInteger)) throw new Error(`Bad tile URL ${url}`);
      for (const p of packsForTile(ordered, z, x, y)) {
        const tile = await reader(p).getZxy(z, x, y, abort.signal);
        if (tile) return { data: tile.data };
      }
      return { data: EMPTY };
    }

    if (kind === 'glyphs') {
      const [stacks = '', range = ''] = rest.map(decodeURIComponent);
      for (const stack of stacks.split(',')) {
        const load = assets[`fonts/${stack.trim()}/${range}`];
        if (load) return { data: await load() };
      }
      return { data: EMPTY };
    }

    if (kind === 'sprites') {
      const file = rest.join('/');
      // The light sheet is optional (tools/maps/build-packs.mjs fetches it); until it is bundled
      // the light style uses the dark sheet's icons.
      const load =
        assets[`sprites/${file}`] ?? assets[`sprites/${file.replace(/^light(?=[@.])/, 'dark')}`];
      if (!load) throw new Error(`Sprite ${file} is not bundled`);
      const buf = await load();
      if (type === 'json' || file.endsWith('.json'))
        return { data: JSON.parse(new TextDecoder().decode(buf)) as object };
      return { data: buf };
    }

    throw new Error(`Unknown map resource ${url}`);
  };
}
