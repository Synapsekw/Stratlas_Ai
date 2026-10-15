import { getActiveScene, layerBox } from '@aio/engine';
import { workspace } from '@aio/workspace';
import { Vector3 } from 'three';
import type { BoundsDeps, Box } from './layerBounds';

let fileExtentSource: (layerId: string) => Promise<Box | null> = () => Promise.resolve(null);

/** Where main's file extents come from (Task 14: `layer:info`). */
export function setFileExtentSource(fn: (layerId: string) => Promise<Box | null>): void {
  fileExtentSource = fn;
}

/** `layerBounds` deps for the open project and the live 3D view. */
export function appBoundsDeps(): BoundsDeps {
  const ws = workspace.getState();
  const manifest = ws.project?.manifest ?? { layers: [] };
  return {
    manifest: manifest as BoundsDeps['manifest'],
    orientation: ws.orientation,
    sceneBox: (id) => {
      const h = getActiveScene();
      const b = h ? layerBox(h.scene, id) : null;
      return b ? { min: b.min.toArray(), max: b.max.toArray() } : null;
    },
    fileExtent: (id) => fileExtentSource(id),
    rayDown: (x, z) => {
      const h = getActiveScene();
      const hit = h?.raycastRay(new Vector3(x, 20_000, z), new Vector3(0, -1, 0));
      return hit ? hit.point.y : null;
    },
  };
}
