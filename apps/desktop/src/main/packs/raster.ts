/**
 * Imagery and terrain packs (M10 stream G7, decision 4): raster PMTiles with `aio.raster-pack/1`
 * metadata in `<data>/packs/imagery/` and `<data>/packs/terrain/`, folders the street-map pack
 * manager (`manager.ts`) and older builds never scan. Import starts a `packs.imagery` or
 * `packs.terrain` job; customer imagery is marked `customerLicence` (decision 12). G0 stubs: no
 * pack is listed yet, and import and remove answer "not available yet".
 */
import { notYet, type Handle } from '../notYet';

export interface RasterPacksIpcDeps {
  handle: Handle;
}

export function registerRasterPacksIpc({ handle }: RasterPacksIpcDeps): void {
  const what = 'Imagery and terrain packs';
  handle('imageryPacks:list', () => ({ ok: true as const, packs: [] }));
  handle('imageryPacks:import', () => notYet(what));
  handle('imageryPacks:remove', () => notYet(what));
  handle('terrainPacks:list', () => ({ ok: true as const, packs: [] }));
  handle('terrainPacks:import', () => notYet(what));
  handle('terrainPacks:remove', () => notYet(what));
}
