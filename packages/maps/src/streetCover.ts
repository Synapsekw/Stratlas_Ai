import { tileBbox, type MapPack } from './packs';

/**
 * Which tiles of the street map are worth drawing for the Globe (`streetTiles.ts`). A street pack
 * is drawn a few levels past its own deepest zoom, where MapLibre overscales its vectors and
 * lines stay crisp; deeper than that the Globe keeps the last tile and stretches it. The world
 * overview goes further past its zoom than a regional pack, because it is all there is across
 * most of the Earth.
 */
interface Extent {
  /** West, south, east, north in degrees (`MapPack.bbox`). */
  bbox: readonly number[];
  maxZoom: MapPack['maxZoom'];
}

/** Levels drawn past a pack's own `maxZoom`. */
export const STREET_OVERZOOM = { world: 4, regional: 3 } as const;
/** Nothing is drawn deeper than this, whatever a pack claims. */
export const STREET_MAX_LEVEL = 18;

const worldWide = ([w = 0, s = 0, e = 0, n = 0]: readonly number[]) =>
  w <= -179.9 && e >= 179.9 && s <= -84 && n >= 84;

const deepest = (p: Extent) =>
  Math.min(
    STREET_MAX_LEVEL,
    p.maxZoom + (worldWide(p.bbox) ? STREET_OVERZOOM.world : STREET_OVERZOOM.regional),
  );

const meets = (a: readonly number[], b: readonly number[]) =>
  (a[0] ?? 0) < (b[2] ?? 0) &&
  (a[2] ?? 0) > (b[0] ?? 0) &&
  (a[1] ?? 0) < (b[3] ?? 0) &&
  (a[3] ?? 0) > (b[1] ?? 0);

export interface StreetCover {
  /** The deepest level any pack is drawn at; -1 without packs. */
  readonly maxZoom: number;
  /** Whether some pack has something to draw in Web Mercator tile `z/x/y`. */
  has(z: number, x: number, y: number): boolean;
}

export function streetCover(packs: readonly Extent[]): StreetCover {
  const reach = packs.map((p) => ({ bbox: p.bbox, deepest: deepest(p) }));
  return {
    maxZoom: reach.reduce((m, p) => Math.max(m, p.deepest), -1),
    has(z, x, y) {
      const box = tileBbox(z, x, y);
      return reach.some((p) => z <= p.deepest && meets(p.bbox, box));
    },
  };
}
