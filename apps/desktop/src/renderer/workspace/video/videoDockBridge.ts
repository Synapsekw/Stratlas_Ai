/**
 * The video dock owns where the video shows; the older shell flags (`videoHidden`, `videoDocked`)
 * still drive the W key, the island's Video tile, the Video section's Show toggle and the coverage
 * legend. While the Scene is open the two stay in step: the dock's choice for the open project
 * is written to the flags, and a flag flipped elsewhere closes or reopens the dock.
 */
import { useWorkspace } from '@aio/workspace';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { shell, useShell } from '../../shell';
import { useStagePrefs } from '../stagePrefs';
import { sideOf } from '../splitModel';
import { videoDock, type VideoDockMode, type VideoDockState } from './videoDockStore';

/** The shell flags a dock choice reads as: closed is hidden, only floating is undocked. */
export function shellFlags(chosen: VideoDockMode | undefined): {
  videoHidden: boolean;
  videoDocked: boolean;
} {
  return { videoHidden: chosen === 'closed', videoDocked: chosen !== 'floating' };
}

/** A hidden flag flipped by the W key, the island or the Video section: close or reopen. */
export function followHidden(
  store: StoreApi<VideoDockState>,
  projectId: string,
  hidden: boolean,
): void {
  const d = store.getState();
  if (hidden) d.close(projectId);
  else if (d.byProject[projectId] === 'closed') d.reopen(projectId);
}

export function useVideoDockBridge(store: StoreApi<VideoDockState> = videoDock): void {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const chosen = useStore(store, (s) => (projectId ? s.byProject[projectId] : undefined));
  useEffect(() => {
    if (!projectId) return;
    const want = shellFlags(chosen);
    const now = shell.getState();
    if (now.videoHidden !== want.videoHidden || now.videoDocked !== want.videoDocked)
      shell.setState(want);
  }, [projectId, chosen]);
  useEffect(() => {
    if (!projectId) return;
    return shell.subscribe((s, prev) => {
      if (s.videoHidden !== prev.videoHidden) followHidden(store, projectId, s.videoHidden);
    });
  }, [projectId, store]);
}

/**
 * A side of the Split stage shows the video: the tile gives way in the same render, so the clip's
 * one player moves to the pane (the tile leaving later would take its picture with it).
 */
export function useVideoInPane(): boolean {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const splitting = useShell((s) => s.stageMode === 'split');
  const split = useStagePrefs((s) => (projectId ? s.byProject[projectId]?.split : undefined));
  return splitting && split !== undefined && sideOf(split, 'video') !== undefined;
}
