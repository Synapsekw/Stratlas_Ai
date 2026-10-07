import { clipKeys } from '@aio/geo';
import type { OrientationFile } from '@aio/schema';
import { workspace, type DirectionDraft } from '@aio/workspace';
import { useStore } from 'zustand';
import { getMedia, loadFlight } from '../media';
import { shell } from '../shell';
import { createAlignStore, type AlignStore } from './alignStore';
import { createPhotoAlignStore, type PhotoAlignStore } from './photoAlignStore';
import { saveOrientation, withClipKeys, withPhotoFixes } from './orientationFile';

/** "Align camera to map": the app's session store (keyframes being edited, notices). */
export const alignCamera = createAlignStore({
  workspace,
  save: (layerId, keys) =>
    saveOrientation(withClipKeys(workspace.getState().orientation, layerId, keys)),
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

/** "Align photo to map": the photo being aligned and the notices after a save. */
export const photoAlign = createPhotoAlignStore({
  workspace,
  save: (layerId, fixes) =>
    saveOrientation(withPhotoFixes(workspace.getState().orientation, layerId, fixes)),
  showBoth: () => {
    const s = shell.getState();
    if (s.screen !== 'scene') s.go('scene');
    if (s.stageMode !== 'split') s.setStageMode('split');
  },
});

// one alignment at a time: starting one cancels the other
alignCamera.subscribe((s, p) => {
  if (s.session && !p.session) photoAlign.getState().cancel();
});
photoAlign.subscribe((s, p) => {
  if (s.session && !p.session) alignCamera.getState().cancel();
});

export function usePhotoAlign<T>(selector: (s: PhotoAlignStore) => T): T {
  return useStore(photoAlign, selector);
}

const videoOf = (layerId: string) => {
  const l = workspace.getState().project?.manifest.layers.find((x) => x.id === layerId);
  return l?.kind === 'video' ? l : null;
};

/** The keyframes the timeline shows for a clip: the session's while aligning it, else saved. */
function keysOf(layerId: string) {
  const s = alignCamera.getState().session;
  return s?.layerId === layerId
    ? s.keys
    : (clipKeys(workspace.getState().orientation, layerId) ?? []);
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

/** Keyframes by clip for the timeline: saved ones, the clip being aligned from its draft. */
export function timelineKeys(
  orientation: OrientationFile | null,
  draft: DirectionDraft | null,
): Record<string, readonly { t: number }[]> {
  const out: Record<string, readonly { t: number }[]> = {};
  for (const [id, c] of Object.entries(orientation?.clips ?? {})) out[id] = c.keys;
  if (draft) out[draft.layerId] = draft.keys;
  return out;
}
