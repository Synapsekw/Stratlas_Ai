import { volumetric as appVolumetric, type Volumetric } from '@aio/volumetric';
import { workspace as appWorkspace, type Workspace } from '@aio/workspace';
import { useEffect } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { timeline as appTimeline, type TimelineState, type VolumeDates } from './timeline';

/**
 * In a stockpile project the volumes own the survey layers (swipe, cut and fill, the boundary
 * editor's lock): while they are loaded with surveys for the open project, the date bar asks them
 * for a survey and mirrors the one they show, whichever control picked it (the Volumes toolbar,
 * the volumes panel, the date bar).
 */
export function connectVolumeDates(
  v: StoreApi<Volumetric>,
  tl: StoreApi<TimelineState>,
  ws: StoreApi<Workspace>,
): () => void {
  let current: VolumeDates | null = null;
  const sync = () => {
    const s = v.getState();
    const projectId = ws.getState().project?.id;
    const captures = s.file?.captures ?? [];
    if (s.status !== 'ready' || !projectId || s.projectId !== projectId || !captures.length) {
      if (current) {
        current = null;
        tl.getState().setVolumes(null);
      }
      return;
    }
    if (current?.projectId !== projectId) {
      current = {
        projectId,
        epochOf: (capture) =>
          v.getState().file?.captures.find((c) => c.captureId === capture)?.epoch,
        epoch: () => v.getState().epoch,
        setEpoch: (epoch) => {
          v.getState().setEpoch(epoch);
        },
      };
      tl.getState().setVolumes(current);
    }
    const shown = captures.find((c) => c.epoch === s.epoch)?.captureId;
    if (shown) tl.getState().mirrorFocus(shown);
  };
  sync();
  const offVolumes = v.subscribe((s, p) => {
    if (
      s.status !== p.status ||
      s.epoch !== p.epoch ||
      s.file !== p.file ||
      s.projectId !== p.projectId
    )
      sync();
  });
  const offWorkspace = ws.subscribe((s, p) => {
    if (s.project?.id !== p.project?.id) sync();
  });
  // the date bar attaches to a project after the volumes may have loaded: mirror them then
  const offTimeline = tl.subscribe((s, p) => {
    if (s.projectId !== p.projectId || s.index !== p.index) sync();
  });
  return () => {
    offVolumes();
    offWorkspace();
    offTimeline();
    if (current) tl.getState().setVolumes(null);
  };
}

/** Keeps the date bar and the volumes on one survey. Mount once, next to useTimelineSync. */
export function useVolumeDates(): void {
  useEffect(() => connectVolumeDates(appVolumetric, appTimeline, appWorkspace), []);
}
