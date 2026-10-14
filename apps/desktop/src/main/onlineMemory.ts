/**
 * Tiles of the providers whose terms forbid offline storage (Esri, Mapbox; ADR 0007, amendment of
 * 14 Oct 2026), kept in memory for this session only, so panning back over an area does not ask
 * again. Bounded: the tile used longest ago goes first. Nothing is ever written to disk.
 */
export const DEFAULT_MEMORY_CAP_BYTES = 64 * 2 ** 20;

export interface HeldTile {
  data: Buffer;
  /** The content type main answers with (`image/jpeg`, `image/png`, `image/webp`). */
  type: string;
}

export function createMemoryTiles(capBytes = DEFAULT_MEMORY_CAP_BYTES) {
  /** Insertion order is the order of use: the first key is the next to go. */
  const map = new Map<string, HeldTile>();
  let bytes = 0;
  return {
    get(key: string): HeldTile | null {
      const t = map.get(key);
      if (!t) return null;
      map.delete(key);
      map.set(key, t);
      return t;
    },
    put(key: string, tile: HeldTile): void {
      const old = map.get(key);
      if (old) {
        map.delete(key);
        bytes -= old.data.byteLength;
      }
      if (tile.data.byteLength > capBytes) return;
      map.set(key, tile);
      bytes += tile.data.byteLength;
      for (const [k, v] of map) {
        if (bytes <= capBytes) break;
        map.delete(k);
        bytes -= v.data.byteLength;
      }
    },
    stats: () => ({ bytes, tiles: map.size }),
    clear(): void {
      map.clear();
      bytes = 0;
    },
  };
}
