/**
 * Keeps the point cloud tabs and the stores that open them in step (stage island D18):
 * - `shell.setCloudPanel(true)` (the palette, the layer menu, the sidebar) brings the `clouds`
 *   workbench to the front with its controls open; the flag is cleared once handled, so asking
 *   again always works (also in a project without a cloud, where the tab is not listed);
 * - the Clean up panel is the `cleanup` tab: opening the panel opens the tab, closing either one
 *   closes the other.
 * The sidebar unfolds when one of them is asked for, as the panel on the stage was always seen.
 */
import { useEffect, useRef } from 'react';
import { sectionStore } from './sectionState';
import { cleanup, useCleanup } from '../../pointcloud/cleanupStore';
import { shell, useShell } from '../../shell';
import { useWorkbench, workbench } from './workbenchStore';

export function useBenchFollow(): void {
  const asked = useShell((s) => s.cloudPanelOpen);
  useEffect(() => {
    if (!asked) return;
    shell.getState().setRight(false);
    workbench.getState().open('clouds');
    // the controls the person asked for are not left folded away
    sectionStore.getState().toggle('clouds', 'cloud-colour', false);
    shell.getState().setCloudPanel(false);
  }, [asked]);

  const panelOpen = useCleanup((s) => s.panelOpen);
  const tabOpen = useWorkbench((s) => s.tabs.some((t) => t.id === 'cleanup'));
  const seen = useRef(false);
  useEffect(() => {
    if (!panelOpen) {
      seen.current = false;
      if (tabOpen) workbench.getState().close('cleanup');
      return;
    }
    if (tabOpen) {
      seen.current = true;
      return;
    }
    if (seen.current) {
      // the tab was closed with the panel open
      seen.current = false;
      cleanup.closePanel();
      return;
    }
    shell.getState().setRight(false);
    workbench.getState().open('cleanup');
  }, [panelOpen, tabOpen]);
}
