/** The Point cloud group: the point cloud panel and Clean up. */
import { PointCloudControls } from '@aio/pointcloud';
import type { Layer } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { openCleanupPanel } from '../../pointcloud/cleanupActions';
import { cleanup, useCleanup } from '../../pointcloud/cleanupStore';
import { PopTool, Tool } from '../StageTools';

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

/** The point cloud panel: show it, colour by RGB, elevation, intensity or flight, size, EDL. */
export function CloudTools() {
  const t = useT();
  const cleanupOpen = useCleanup((s) => s.panelOpen);
  const { ids, shown, many, toggle } = useCloudLayers();
  if (ids.length === 0) return null;
  return (
    <>
      <PopTool icon="cloud" label="Point cloud" wide>
        <div className="pop-form" data-testid="cloud-panel">
          <span className="pop-title">Point cloud{many ? 's' : ''}</span>
          <label className="pop-row">
            <Icon name="cloud" size={14} className="muted" />
            <span className="pop-grow">Show the point cloud{many ? 's' : ''}</span>
            <input type="checkbox" checked={shown} onChange={toggle} />
          </label>
          <PointCloudControls className="pop-form" />
        </div>
      </PopTool>
      <Tool
        icon="boxclip"
        label={t('cleanup.tool')}
        pressed={cleanupOpen}
        testId="cleanup-tool"
        onClick={() => {
          if (cleanupOpen) cleanup.closePanel();
          else openCleanupPanel();
        }}
      />
    </>
  );
}
