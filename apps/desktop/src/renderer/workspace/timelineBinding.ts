import { buildTimelineModel, type TimelineModel } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useMemo } from 'react';
import { jumpToKeyframe, moveKeyframe, timelineKeys } from '../builder/alignSession';
import { useMedia } from '../media';
import { toggleTimeline } from './timelinePref';

/**
 * What both bottom timelines (the single track and the date lanes) read from the workspace: the
 * playback state, the selection and the timeline model of the open project (null without one).
 */
export function useTimelineBinding() {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const nowMs = useWorkspace((s) => s.nowMs);
  const playing = useWorkspace((s) => s.playing);
  const rate = useWorkspace((s) => s.rate);
  const activeClip = useWorkspace((s) => s.activeClip);
  const selectedIssue = useWorkspace((s) =>
    s.selection?.kind === 'issue' ? s.selection.id : null,
  );
  const directionDraft = useWorkspace((s) => s.directionDraft);
  const orientation = useWorkspace((s) => s.orientation);
  const { durations } = useMedia(project);
  const model = useMemo<TimelineModel | null>(
    () =>
      project
        ? buildTimelineModel(
            project.manifest,
            issues,
            durations,
            timelineKeys(orientation, directionDraft),
          )
        : null,
    [project, issues, durations, orientation, directionDraft],
  );
  return { project, nowMs, playing, rate, activeClip, selectedIssue, model };
}

/** The workspace actions both bottom timelines share. */
export const timelineActions = {
  onHide: () => {
    toggleTimeline(workspace.getState().project);
  },
  onSeek: (t: number) => {
    workspace.getState().setTime(t);
  },
  onIssue: (id: string) => {
    workspace.getState().select({ kind: 'issue', id });
  },
  onKeyframe: (layerId: string, index: number) => {
    jumpToKeyframe(layerId, index);
  },
  onKeyframeMove: (layerId: string, index: number, tMs: number, phase: 'move' | 'end') => {
    moveKeyframe(layerId, index, tMs, phase);
  },
  onTogglePlay: () => {
    const ws = workspace.getState();
    if (ws.playing) ws.pause();
    else ws.play();
  },
  onRate: (r: number) => {
    workspace.getState().setRate(r);
  },
};
