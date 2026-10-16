/**
 * Opening the point cloud Clean up panel from a menu or the stage tools. The menu items
 * themselves are the `pointcloud.*` actions in shell/actions/kindActions.tsx.
 */
import { shell } from '../shell';
import { cleanup } from './cleanupStore';

export interface CleanupActionContext {
  openPanel(layerId: string, section?: 'noise' | 'save'): void;
  reset(layerId: string): Promise<boolean>;
}

/**
 * Open the Clean up panel where it lives, on the 3D view: from Map mode switch the stage to 3D
 * first (the same view-mode action as the toolbar's); split and 3D stay as they are.
 */
export function openCleanupPanel(layerId?: string, section?: 'noise' | 'save'): void {
  const s = shell.getState();
  if (s.stageMode === 'map') s.setStageMode('3d');
  cleanup.openPanel(layerId, section);
}

export const cleanupActionContext: CleanupActionContext = {
  openPanel: (layerId, section) => {
    openCleanupPanel(layerId, section);
  },
  reset: (layerId) => cleanup.reset(layerId),
};
