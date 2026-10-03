import { getAdapter, registerAdapter } from '../registry';
import { meshAdapter } from './mesh';
import { panoramasAdapter } from './panoramas';
import { photosAdapter } from './photos';
import { rasterAdapter } from './raster';

/**
 * Registers the engine's adapters: `mesh` (GLB with Meshopt, optional DRACO), `raster`
 * (`image` and `kit-pyramid`; other formats plug in with registerRasterFormat), `photos`
 * (posed photos as camera frustums) and `panoramas` (markers that open an immersive view).
 * Idempotent.
 */
export function registerEngineAdapters(): void {
  if (!getAdapter('mesh')) registerAdapter(meshAdapter);
  if (!getAdapter('raster')) registerAdapter(rasterAdapter);
  if (!getAdapter('photos')) registerAdapter(photosAdapter);
  if (!getAdapter('panoramas')) registerAdapter(panoramasAdapter);
}
