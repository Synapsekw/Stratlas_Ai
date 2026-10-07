/**
 * How much of a tileset the site view keeps per graphics tier (the same words as the renderer's
 * `GpuTier`). `errorTarget` is the screen-space error in pixels 3DTilesRendererJS refines to;
 * `maxBytes` caps its tile cache. G7 tunes the numbers against the M7 performance budgets.
 */
export type TilesTier = 'low' | 'medium' | 'high' | 'ultra';

export interface TilesBudget {
  errorTarget: number;
  maxBytes: number;
  /** Terrain and imagery around the site (Settings) are offered from this tier up. */
  surroundings: boolean;
}

const MB = 2 ** 20;

export const TILES_BUDGETS: Readonly<Record<TilesTier, TilesBudget>> = {
  low: { errorTarget: 24, maxBytes: 128 * MB, surroundings: false },
  medium: { errorTarget: 12, maxBytes: 384 * MB, surroundings: true },
  high: { errorTarget: 6, maxBytes: 768 * MB, surroundings: true },
  ultra: { errorTarget: 4, maxBytes: 1536 * MB, surroundings: true },
};

export function tilesBudget(tier: TilesTier): TilesBudget {
  return TILES_BUDGETS[tier];
}
