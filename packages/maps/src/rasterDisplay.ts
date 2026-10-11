import type { Layer } from '@aio/schema';
import type { LayerDisplay } from '@aio/workspace';

type RasterLayer = Extract<Layer, { kind: 'raster' }>;
type RasterRole = RasterLayer['role'];

/**
 * Whether the map fetches a raster when the project opens. A drawing drawn as one picture
 * (`role: 'plan'`, `format: 'image'`) that is hidden waits until it is first shown: a set of
 * sheets nobody is looking at must not be decoded on every open. Everything else loads as before.
 */
export function loadsWithProject(
  layer: Pick<RasterLayer, 'role' | 'format'>,
  hidden: boolean,
): boolean {
  return !(hidden && layer.role === 'plan' && layer.format === 'image');
}

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
