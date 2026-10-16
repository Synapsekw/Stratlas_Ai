import { getActiveScene } from '@aio/engine';
import { cloudLowHeight } from '@aio/pointcloud';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { appBoundsDeps } from '../shell/appBounds';
import { boundsOf } from '../shell/layerBounds';
import { createDropStore, type DropStore } from './dropStore';
import { DROP_CLOUD_PERCENTILE } from './dropToGround';
import { modelBaseY } from './modelPlacement';
import { builder } from './state';

/** A model's low point: its lowest vertex as drawn (Place model's measure), else its file extent. */
async function meshLow(layerId: string): Promise<number | null> {
  const y = modelBaseY(layerId);
  if (y !== null) return y;
  const box = await appBoundsDeps().fileExtent(layerId);
  return box ? box.min[1] : null;
}

/** Drop to ground: datasets onto the DSM (else the project ground level), with Undo. */
export const dropToGround = createDropStore({
  workspace,
  save: (layerId, patch) => builder.getState().saveLayers([layerId], patch),
  low: (layerId) => {
    const l = workspace.getState().project?.manifest.layers.find((x) => x.id === layerId);
    if (l?.kind === 'mesh') return meshLow(layerId);
    const scene = getActiveScene();
    return Promise.resolve(scene ? cloudLowHeight(scene, layerId, DROP_CLOUD_PERCENTILE) : null);
  },
  footprint: (layerId) => boundsOf([layerId], appBoundsDeps()),
  // the DSM straight down in the 3D view, as Align to's ground: nothing else in the scene counts
  ground: (x, z) => {
    const deps = appBoundsDeps();
    for (const l of deps.manifest.layers) {
      if (l.kind !== 'raster' || l.role !== 'dsm') continue;
      const y = deps.rayDown(x, z, l.id);
      if (y !== null) return y;
    }
    return null;
  },
});

export function useDrop<T>(selector: (s: DropStore) => T): T {
  return useStore(dropToGround, selector);
}
