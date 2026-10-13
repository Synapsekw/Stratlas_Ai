import type { ProjectManifest } from '@aio/schema';
import type { RenameOptions } from '../import/rename';
import { readManifestFile } from './manifestFile';
import { removeItems } from './remove';

/*
 * Removing a walk (the walk layer and placing, "The smaller points"): one case of `removeItems`
 * (delete and start over, 13 Oct 2026). Its folder `walks/<id>/` moves to `.trash/<stamp>-<id>/`
 * as before, now with `removed.json`; the folder moves first, the layer leaves the manifest in one
 * save, and a failed save moves the folder back.
 */

export { sweepTrash, TRASH_DIR, TRASH_KEEP_DAYS } from './trash';

export interface RemoveWalkOptions {
  rename?: RenameOptions['rename'];
}

export async function removeWalk(
  root: string,
  layerId: string,
  now: () => Date = () => new Date(),
  o: RemoveWalkOptions = {},
): Promise<ProjectManifest> {
  const layer = (await readManifestFile(root)).layers.find((l) => l.id === layerId);
  if (!layer) throw new Error(`There is no layer "${layerId}" in this project.`);
  if (layer.kind !== 'walk') throw new Error(`"${layer.name}" is not a walk.`);
  return (await removeItems(root, [{ layer: layerId }], now, { ...o, walkLayout: true })).manifest;
}
