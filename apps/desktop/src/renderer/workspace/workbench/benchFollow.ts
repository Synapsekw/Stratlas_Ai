/**
 * Keeps the point cloud tabs and the stores that open them in step (stage island D18):
 * - `shell.setCloudPanel(true)` (the palette, the layer menu, the sidebar) brings the `clouds`
 *   workbench to the front; the flag clears when that tab is left or closed, so asking again works;
 * - the Clean up panel is the `cleanup` tab: opening the panel opens the tab, closing either one
 *   closes the other.
 * The sidebar unfolds when one of them is asked for, as the panel on the stage was always seen.
 */
import { useEffect, useRef } from 'react';
import { cleanup, useCleanup } from '../../pointcloud/cleanupStore';
import { shell, useShell } from '../../shell';
import { useWorkbench, workbench } from './workbenchStore';

export function useBenchFollow(): void {
  const asked = useShell((s) => s.cloudPanelOpen);
  const front = useWorkbench((s) => s.front);
  const armed = useRef(false);
  useEffect(() => {
    if (!asked) {
      armed.current = false;
      return;
    }
    if (front === 'clouds') armed.current = true;
    else if (armed.current) {
      // the tab was left (or closed) after it came to the front
      armed.current = false;
      shell.getState().setCloudPanel(false);
    }
  }, [asked, front]);
  useEffect(() => {
    if (!asked) return;
    shell.getState().setRight(false);
    workbench.getState().open('clouds');
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
