/** The open project's point cloud layers, for the Point cloud workbench. */
import type { Layer } from '@aio/schema';
import { useWorkspace, workspace } from '@aio/workspace';

/** Cloud layer ids of the open project, joined (a stable selector value). */
const cloudIds = (layers: readonly Layer[] | undefined) =>
  (layers ?? [])
    .filter((l) => l.kind === 'pointcloud')
    .map((l) => l.id)
    .join('|');

/** The open project's point cloud layers and one switch for all of them. */
export function useCloudLayers() {
  const joined = useWorkspace((s) => cloudIds(s.project?.manifest.layers));
  const ids = joined ? joined.split('|') : [];
  const shown = useWorkspace((s) => ids.some((id) => !s.hidden[id]));
  return {
    ids,
    shown,
    many: ids.length > 1,
    toggle: () => {
      for (const id of ids) workspace.getState().setLayerVisible(id, !shown);
    },
  };
}
