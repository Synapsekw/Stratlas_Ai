import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { builder } from '../builder/state';
import { bridge, shell } from '../shell';
import { PANE_KINDS } from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';
import { splitWithWalk } from './walkModel';
import { createWalkStore, type WalkState } from './walkStore';

/** The 360 videos of the open project, kept in step with it. */
export const walks = createWalkStore((projectId) => bridge.call('walks:list', { projectId }));

export function useWalks<T>(selector: (s: WalkState) => T): T {
  return useStore(walks, selector);
}

/** Ask main again (after an import added a walk). */
export function refreshWalks(): Promise<void> {
  return walks.getState().load(workspace.getState().project?.id ?? null);
}

let followed: string | null | undefined;
const follow = () => {
  const id = workspace.getState().project?.id ?? null;
  if (id === followed) return;
  followed = id;
  void walks.getState().load(id);
};
workspace.subscribe(follow);
follow();

// 360 video lands beside the manifest (walks/), which the workspace does not follow: when an
// import ends, the list is asked for again
builder.subscribe((s, prev) => {
  if (prev.importing && !s.importing) void refreshWalks();
});

/** Show a walk: the Scene screen in split view, the 360 video pane where it is or on the right. */
export function openWalk(id: string): void {
  const project = workspace.getState().project;
  if (!project) return;
  walks.getState().select(id);
  const sh = shell.getState();
  if (sh.screen !== 'scene') sh.go('scene');
  const saved = stagePrefs.getState().byProject[project.id]?.split;
  // every pane counts as offered here: the split itself drops what the project cannot fill
  stagePrefs.getState().update(project.id, { split: splitWithWalk(saved, PANE_KINDS) });
  if (sh.stageMode !== 'split') sh.setStageMode('split');
}
