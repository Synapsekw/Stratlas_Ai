import { laneFocusTarget, type Lane } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { pickClip } from './pickClip';
import { timeline } from './timeline';

/** The lanes and the clock as last drawn. */
export interface LaneView {
  projectId: string;
  lanes: readonly Lane[];
  offsetMin: number;
  nowMs: number;
}

/**
 * Keep the real playhead on the focused lane. Whenever the focus moves to another date (a lane
 * label, a drag or clip click in another lane, the calendar, the date arrows, Alt+Left/Right),
 * the clock goes to the same site time of day on the new date: into its clip there, selected
 * and not playing, else onto the date itself, where an active clip of another date is dropped so
 * Play never plays it. `view()` returns the lanes and the clock as last drawn, which is the time
 * of day the user saw: `focusSurvey` may move the clock before the focus changes.
 *
 * It runs inside the focus change, so a drag or a clip click that focuses a lane and then seeks
 * still ends where it seeks. Returns the unsubscribe.
 */
export function followLaneFocus(view: () => LaneView | null): () => void {
  return timeline.subscribe((s, prev) => {
    if (!s.focus || !prev.focus || s.focus === prev.focus) return;
    if (s.projectId !== prev.projectId) return;
    const v = view();
    if (v?.projectId !== s.projectId) return;
    const to = v.lanes.find((l) => l.captureId === s.focus);
    if (!to) return;
    const from = v.lanes.find((l) => l.captureId === prev.focus);
    const target = laneFocusTarget(from, to, v.nowMs, v.offsetMin);
    if (target.clip) {
      pickClip(target.clip.layerId, target.utcMs, target.clip);
      return;
    }
    const ws = workspace.getState();
    ws.setTime(target.utcMs);
    const active = ws.activeClip;
    const of = s.index?.of ?? {};
    if (active && active in of && of[active] !== s.focus) ws.setActiveClip(null);
  });
}
