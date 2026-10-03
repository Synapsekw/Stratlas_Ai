import { getAdapter, registerAdapter } from '../registry';
import { meshAdapter } from './mesh';
import { rasterAdapter } from './raster';

/**
 * Registers the engine's adapters: `mesh` (GLB with Meshopt, optional DRACO) and `raster`
 * (`image` and `kit-pyramid`; other formats plug in with registerRasterFormat). Idempotent.
 */
export function registerEngineAdapters(): void {
  if (!getAdapter('mesh')) registerAdapter(meshAdapter);
  if (!getAdapter('raster')) registerAdapter(rasterAdapter);
}
