import { getActiveStage } from '@aio/engine';
import { layerTransformToGeoref, type ProjectGeo } from '@aio/geo';
import type { Georef, LayerPatch, Mat4, Placement } from '@aio/schema';
import { Box3 } from 'three';

/**
 * Where a model sits, as saved: its transform with the georeference and placement that go with
 * it. Place model keeps one for Undo after Done; Drop to ground plans its move from one.
 */
export interface SavedPlacement {
  transform: Mat4;
  georef?: Georef | undefined;
  placement?: Placement | undefined;
}

/** The one write that puts a saved placement back (all of it, in one patch). */
export function patchOf(s: SavedPlacement): LayerPatch {
  return s.georef !== undefined || s.placement !== undefined
    ? {
        transform: s.transform,
        ...(s.georef !== undefined ? { georef: s.georef } : {}),
        ...(s.placement !== undefined ? { placement: s.placement } : {}),
      }
    : { transform: s.transform };
}

/** Whether a move is a placing: the model has a georeference, or waits for placing. */
export function isPlacing(model: SavedPlacement): boolean {
  return model.georef !== undefined || (model.placement ?? 'placed') !== 'placed';
}

/**
 * The write that moves a model to `transform`, as Place model saves on Done: a georeferenced model
 * gets a georeference set by the person (`place-model`), and one that waited for placing is marked
 * placed, all with the transform in one write; any other model gets its transform alone.
 */
export function placedPatch(
  model: SavedPlacement,
  transform: Mat4,
  project: ProjectGeo,
): LayerPatch {
  if (!isPlacing(model)) return patchOf({ transform });
  const georef = model.georef
    ? layerTransformToGeoref(transform, project, model.georef, 'place-model')
    : undefined;
  return patchOf({ transform, georef, placement: 'placed' });
}

/**
 * The lowest point of a model as drawn now, local y (the box of its layer group in the 3D view);
 * null without a 3D view or when nothing of it is drawn.
 */
export function modelBaseY(layerId: string): number | null {
  const group = getActiveStage()?.scene.getObjectByName(`layer:${layerId}`);
  if (!group) return null;
  group.updateMatrixWorld(true);
  const box = new Box3().setFromObject(group);
  return box.isEmpty() ? null : box.min.y;
}
