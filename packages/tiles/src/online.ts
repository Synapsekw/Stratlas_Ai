import { onlineSource, onlineTileUrl, type OnlineSourceId } from '@aio/schema';
import type { RasterPack, RasterTileSource } from './packs';

/**
 * An online source (ADR 0007, amendments of 10 and 14 Oct 2026) as a tile provider for the
 * imagery around the site in 3D (`buildSurroundings`). It asks the app's own address,
 * `aio://online/<id>/<z>/<x>/<y>`; main serves or refuses each tile. The source looks like one
 * pack that covers the whole Earth, so `buildSurroundings` treats it like the packs.
 */
export function createOnlineTileSource(
  id: OnlineSourceId,
  read: (url: string, signal?: AbortSignal) => Promise<Response> = (url, signal) =>
    fetch(url, signal ? { signal } : {}),
): RasterTileSource {
  const source = onlineSource(id);
  if (!source) throw new Error(`Unknown online source "${id}"`);
  const pack: RasterPack = {
    id,
    kind: 'imagery',
    bbox: [-180, -85.0511, 180, 85.0511],
    minZoom: source.minZoom,
    maxZoom: source.maxZoom,
    attribution: source.attribution,
    licence: source.licence,
    label: source.label,
  };
  return {
    kind: 'imagery',
    packs: [pack],
    minZoom: source.minZoom,
    maxZoom: source.maxZoom,
    tilePx: source.imagePx,
    async getTile(z, x, y, signal) {
      const res = await read(onlineTileUrl(id, z, x, y), signal);
      if (!res.ok) return undefined;
      const data = await res.arrayBuffer();
      return data.byteLength > 0 ? { data, pack } : undefined;
    },
    credits: () => [source.attribution],
  };
}
