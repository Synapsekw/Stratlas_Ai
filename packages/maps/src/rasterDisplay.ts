import type { Layer } from '@aio/schema';
import type { LayerDisplay } from '@aio/workspace';

type RasterRole = Extract<Layer, { kind: 'raster' }>['role'];

/**
 * Opacity of a project raster on the map. A plan (a drawing) takes the person's choice
 * (`layerDisplay`), else 0.75 so the map under it stays readable; photographic rasters are nearly
 * solid. `fine`: a full detail pyramid tile, drawn solid over its coarse backdrop.
 */
export function rasterOpacity(role: RasterRole, display?: LayerDisplay, fine = false): number {
  if (role === 'plan' && display?.opacity !== undefined) return display.opacity;
  if (fine) return 1;
  return role === 'plan' ? 0.75 : 0.95;
}
