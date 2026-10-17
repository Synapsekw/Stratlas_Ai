import { workspace } from '@aio/workspace';
import { shell } from '../shell';
import type { Side, SplitPref } from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';

/*
 * Show one 360 in the Panoramas pane beside the 3D view or the map, as `openPhoto` does for a
 * photo: a line-up needs the 360 and the site side by side.
 */

/** The split with the Panoramas pane on one side, the 3D view or the map on the other. */
export function splitWithPano(sides: SplitPref, beside: '3d' | 'map'): SplitPref {
  if (beside === 'map') return { ...sides, left: 'map', right: 'pano' };
  if (sides.left === '3d') return { ...sides, right: 'pano' };
  if (sides.right === '3d') return { ...sides, left: 'pano' };
  return { ...sides, left: '3d', right: 'pano' };
}

/** `p` with `side` showing `capture` (undefined: whatever date that side shows by default). */
function withSideCapture(p: SplitPref, side: Side, capture: string | undefined): SplitPref {
  const { leftCapture, rightCapture, ...rest } = p;
  const left = side === 'left' ? capture : leftCapture;
  const right = side === 'right' ? capture : rightCapture;
  return {
    ...rest,
    ...(left ? { leftCapture: left } : {}),
    ...(right ? { rightCapture: right } : {}),
  };
}

/** The view the stage shows the site in now: the map when no 3D view is on screen. */
export function siteView(): '3d' | 'map' {
  const sh = shell.getState();
  if (sh.stageMode === 'map') return 'map';
  if (sh.stageMode !== 'split') return '3d';
  const id = workspace.getState().project?.id;
  const split = id ? stagePrefs.getState().byProject[id]?.split : undefined;
  if (!split || split.left === '3d' || split.right === '3d') return '3d';
  return split.left === 'map' || split.right === 'map' ? 'map' : '3d';
}

/**
 * Open 360 `panoId` of `layerId` in the split beside the 3D view (or the map) and select it. The
 * Panoramas pane shows it on its own date, so the pane's side follows the 360's layer date.
 */
export function openPanoBeside(
  layerId: string,
  panoId: string,
  beside: '3d' | 'map' = siteView(),
): void {
  const w = workspace.getState();
  const project = w.project;
  if (project) {
    const saved: SplitPref = stagePrefs.getState().byProject[project.id]?.split ?? {
      left: '3d',
      right: 'map',
    };
    const sides = splitWithPano(saved, beside);
    const side: Side = sides.left === 'pano' ? 'left' : 'right';
    const capture = project.manifest.layers.find((l) => l.id === layerId)?.capture;
    const next = withSideCapture({ ...sides, pano: `${layerId}/${panoId}` }, side, capture);
    stagePrefs.getState().update(project.id, { split: next });
    const sh = shell.getState();
    if (sh.stageMode !== 'split') sh.setStageMode('split');
    if (sh.screen !== 'scene') sh.go('scene');
  }
  w.select({ kind: 'pano', id: panoId, layer: layerId });
}
