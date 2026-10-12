import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { builder } from '../builder/state';
import { bridge, shell } from '../shell';
import { PANE_KINDS } from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';
import { importAnswered, splitWithWalk } from './walkModel';
import { createWalkStore, type WalkState } from './walkStore';

/** The 360 walks of the open project, kept in step with its manifest. */
export const walks = createWalkStore((projectId) => bridge.call('walks:list', { projectId }));

export function useWalks<T>(selector: (s: WalkState) => T): T {
  return useStore(walks, selector);
}

/** Ask main for the walk records again (after an import added a walk). */
export function refreshWalks(): Promise<void> {
  return walks.getState().refresh();
}

let followedId: string | null | undefined;
let followedLayers: unknown;
const follow = () => {
  const project = workspace.getState().project;
  const id = project?.id ?? null;
  const layers = project?.manifest.layers ?? [];
  if (id === followedId && layers === followedLayers) return;
  followedId = id;
  followedLayers = layers;
  void walks.getState().sync(id, layers);
};
workspace.subscribe(follow);
follow();

// an import answered: a walk folder may have been written beside its new layer
builder.subscribe((s, prev) => {
  if (importAnswered(prev, s)) void refreshWalks();
});

/** Show a walk: the Scene screen in split view, the 360 video pane where it is or on the right. */
export function openWalk(layerId: string): void {
  const project = workspace.getState().project;
  if (!project) return;
  walks.getState().select(layerId);
  const sh = shell.getState();
  if (sh.screen !== 'scene') sh.go('scene');
  const saved = stagePrefs.getState().byProject[project.id]?.split;
  // every pane counts as offered here: the split itself drops what the project cannot fill
  stagePrefs.getState().update(project.id, { split: splitWithWalk(saved, PANE_KINDS) });
  if (sh.stageMode !== 'split') sh.setStageMode('split');
}

let placeHandler: ((layerId: string) => void) | null = null;

/** The Place walk flow registers itself here; the tree row's Place walk calls it. */
export function setPlaceWalkHandler(fn: ((layerId: string) => void) | null): void {
  placeHandler = fn;
}

/** Start placing a walk (the Place walk strip), when that flow is registered. */
export function placeWalk(layerId: string): void {
  placeHandler?.(layerId);
}

/**
 * Remove a walk from the project: main takes its layer out of the manifest and moves its folder
 * to the project trash (`walks:remove`). Null when it is gone, else why not.
 */
export async function removeWalk(layerId: string): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  const r = await bridge.call('walks:remove', { projectId: project.id, layerId });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  workspace.getState().replaceManifest(r.value.manifest);
  return null;
}
