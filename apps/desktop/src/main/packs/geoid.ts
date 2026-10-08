/**
 * Geoid packs (M11 stream G1): regional geoid grids (GeoTIFF or GTX) in `<data>/packs/geoid/`,
 * imported with the licence and attribution the person states, beside the global EGM96 and
 * EGM2008 grids that ship in the pipeline pack. G0 stubs: every channel answers "not available
 * yet".
 */
import { notYet, type Handle } from '../notYet';

export interface GeoidPacksIpcDeps {
  handle: Handle;
}

export function registerGeoidPacksIpc({ handle }: GeoidPacksIpcDeps): void {
  const what = 'Geoid packs';
  handle('geoidPacks:list', () => notYet(what));
  handle('geoidPacks:import', () => notYet(what));
  handle('geoidPacks:remove', () => notYet(what));
}
