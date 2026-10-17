/** The Point cloud group: the point cloud panel and Clean up. */
import { PointCloudControls } from '@aio/pointcloud';
import type { Layer } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { openCleanupPanel } from '../../pointcloud/cleanupActions';
import { cleanup, useCleanup } from '../../pointcloud/cleanupStore';
import { shell, useShell } from '../../shell';
import { PopTool, Tool } from '../StageTools';

/** Cloud layer ids of the open project, joined (a stable selector value). */
const cloudIds = (layers: readonly Layer[] | undefined) =>
  (layers ?? [])
    .filter((l) => l.kind === 'pointcloud')
    .map((l) => l.id)
    .join('|');

/** The point cloud panel: show it, colour by RGB, elevation, intensity or flight, size, EDL. */
export function CloudTools() {
  const t = useT();
  const open = useShell((s) => s.cloudPanelOpen);
  const cleanupOpen = useCleanup((s) => s.panelOpen);
  const ids = useWorkspace((s) => cloudIds(s.project?.manifest.layers));
  const shown = useWorkspace((s) => ids.split('|').some((id) => id && !s.hidden[id]));
  const many = ids.includes('|');
  if (!ids) return null;
  return (
    <>
      <PopTool
        icon="cloud"
        label="Point cloud"
        wide
        open={open}
        onOpenChange={(o) => {
          shell.getState().setCloudPanel(o);
        }}
      >
        <div className="pop-form" data-testid="cloud-panel">
          <span className="pop-title">Point cloud{many ? 's' : ''}</span>
          <label className="pop-row">
            <Icon name="cloud" size={14} className="muted" />
            <span className="pop-grow">Show the point cloud{many ? 's' : ''}</span>
            <input
              type="checkbox"
              checked={shown}
              onChange={() => {
                for (const id of ids.split('|')) workspace.getState().setLayerVisible(id, !shown);
              }}
            />
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
