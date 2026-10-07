import type { ProjectManifest } from '@aio/schema';

/** Layers drawn as 3D content (or their own viewer): their projects open in the 3D view. */
const CONTENT_3D = new Set(['mesh', 'pointcloud', 'raster', 'legacy']);

/**
 * A project placed on the Earth whose first data is drone video or located photos, with nothing
 * 3D yet (no model, cloud, ortho or terrain). It opens with the 3D view and the map side by side,
 * so the flights show on the street map at once; once 3D content arrives, the 3D view leads.
 */
export function videoFirst(manifest: ProjectManifest): boolean {
  if (!('epsg' in manifest.crs)) return false;
  const layers = manifest.layers;
  if (layers.some((l) => CONTENT_3D.has(l.kind))) return false;
  return layers.some(
    (l) => l.kind === 'video' || (l.kind === 'photos' && l.items.some((p) => p.pos !== undefined)),
  );
}
