import { workspace } from '@aio/workspace';
import { dropEvidence } from '../issueCard/evidence';
import { shell } from '../shell';
import { splitWithPhoto, type SplitPref } from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';

/**
 * The scene is already showing a photo beside the other view, so a new photo selection stays
 * here instead of opening the Media screen.
 */
export function photoSplitIsOpen(): boolean {
  if (shell.getState().stageMode !== 'split') return false;
  const id = workspace.getState().project?.id;
  if (!id) return false;
  const split = stagePrefs.getState().byProject[id]?.split;
  return split?.left === 'photo' || split?.right === 'photo';
}

/**
 * Show one photo in the split view and stay on the scene. From the map the map is on the left
 * and the photo on the right. From the 3D view the model stays and the photo takes the other side.
 */
export function openPhoto(layerId: string, photoId: string, beside: '3d' | 'map' = '3d'): void {
  dropEvidence();
  const w = workspace.getState();
  const id = w.project?.id;
  if (id) {
    const saved: SplitPref = stagePrefs.getState().byProject[id]?.split ?? {
      left: '3d',
      right: 'map',
    };
    stagePrefs.getState().update(id, { split: splitWithPhoto(saved, beside) });
    const sh = shell.getState();
    if (sh.stageMode !== 'split') sh.setStageMode('split');
    if (sh.screen !== 'scene') sh.go('scene');
  }
  w.select({ kind: 'photo', id: photoId, layer: layerId });
}
