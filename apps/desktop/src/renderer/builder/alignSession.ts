import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { getMedia, loadFlight } from '../media';
import { shell } from '../shell';
import { createAlignStore, type AlignStore } from './alignStore';
import { builder } from './state';

/** "Align camera to map": the app's session store (keyframes being edited, notices). */
export const alignCamera = createAlignStore({
  workspace,
  save: (layerId, keys) => builder.getState().saveLayers([layerId], { directionKeys: keys }),
  flight: (layerId) => getMedia().flights[layerId] ?? null,
  loadFlight: (layerId) => {
    const project = workspace.getState().project;
    const layer = project?.manifest.layers.find((l) => l.id === layerId);
    if (project && layer?.kind === 'video') loadFlight(project, layer);
  },
  duration: (layerId) => getMedia().durations[layerId] ?? null,
  showBoth: () => {
    const s = shell.getState();
    if (s.screen !== 'scene') s.go('scene');
    if (s.stageMode !== 'split') s.setStageMode('split');
  },
});

export function useAlign<T>(selector: (s: AlignStore) => T): T {
  return useStore(alignCamera, selector);
}

const videoOf = (layerId: string) => {
  const l = workspace.getState().project?.manifest.layers.find((x) => x.id === layerId);
  return l?.kind === 'video' ? l : null;
};

/** The keyframes the timeline shows for a clip: the session's while aligning it, else saved. */
function keysOf(layerId: string) {
  const s = alignCamera.getState().session;
  return s?.layerId === layerId ? s.keys : (videoOf(layerId)?.directionKeys ?? []);
}

/** A keyframe diamond on the timeline was clicked: the playhead goes to it. */
export function jumpToKeyframe(layerId: string, index: number): void {
  const clip = videoOf(layerId);
  const k = keysOf(layerId)[index];
  if (!clip || !k) return;
  const w = workspace.getState();
  w.pause();
  if (w.activeClip !== layerId) w.setActiveClip(layerId);
  w.setTime(clip.flight.startUtcMs + clip.offsetMs + k.t);
}

/** A keyframe diamond is dragged in time (it moves in an aligning session, saved with Done). */
export function moveKeyframe(
  layerId: string,
  index: number,
  tMs: number,
  phase: 'move' | 'end',
): void {
  const clip = videoOf(layerId);
  if (!clip) return;
  const a = alignCamera.getState();
  if (a.session?.layerId !== layerId) a.start(layerId);
  // one undo step for the whole drag
  if (phase === 'move') a.gesture(true);
  a.moveKey(layerId, index, tMs - clip.flight.startUtcMs - clip.offsetMs);
  if (phase === 'end') {
    a.gesture(false);
    jumpToKeyframe(layerId, index);
  }
}
