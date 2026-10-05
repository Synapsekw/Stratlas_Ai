import type { WindowKind } from '@aio/schema';
import type { StageMode } from '../store';

/** Panes of the Scene screen that take focus (FocusZone). */
const SCENE_WINDOWS: readonly WindowKind[] = ['scene3d', 'map', 'video', 'photo', 'pointcloud'];

/**
 * The window the Scene's agent is bound to: the pane the person last used here (3D, map, video,
 * photos), else the stage. Focus left on another screen (Issues, Reports) does not carry over.
 */
export function agentWindow(focused: WindowKind | null, stageMode: StageMode): WindowKind {
  if (focused && SCENE_WINDOWS.includes(focused)) return focused;
  return stageMode === 'map' ? 'map' : 'scene3d';
}
