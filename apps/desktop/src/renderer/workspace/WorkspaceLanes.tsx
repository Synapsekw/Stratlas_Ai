import { buildLaneModel, LaneTimeline, laneNeighbour, offsetLabel } from '@aio/ui';
import { clock, dateTags, useWorkspace, workspace } from '@aio/workspace';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DatePicker } from './DatePicker';
import { followLaneFocus, type LaneView } from './laneFocus';
import { siteOffset } from './lanes';
import { pickClip, selectClip } from './pickClip';
import { timeline, useTimeline } from './timeline';
import { timelineActions, useTimelineBinding } from './timelineBinding';

/** What the lanes are built from: the timeline binding, the dates, the focus and the site clock. */
function useLaneSource() {
  const binding = useTimelineBinding();
  const index = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  const { project } = binding;
  const offset = useMemo(() => (project ? siteOffset(project.manifest) : null), [project]);
  return { ...binding, index, focus, offset };
}

const SHUT = { earlier: false, later: false };

/**
 * Keeps the real playhead on the focused lane while a lane project is open, with the timeline
 * shown or folded to the date row (`followLaneFocus`). Draws nothing.
 */
export function LaneFocusFollow() {
  const { project, model: base, index, focus, offset } = useLaneSource();
  // the workspace's clock (exact after a seek or pause, a few times a second while playing): the
  // time of day the user saw, without a render per playback frame
  const nowMs = useWorkspace((s) => s.nowMs);
  const lanes = useMemo(
    () => (base && index ? buildLaneModel(base, index, focus, offset ?? 0, SHUT).lanes : null),
    [base, index, focus, offset],
  );
  const seen = useRef<LaneView | null>(null);
  useLayoutEffect(() => {
    seen.current =
      project && lanes ? { projectId: project.id, lanes, offsetMin: offset ?? 0, nowMs } : null;
  });
  useEffect(() => followLaneFocus(() => seen.current), []);
  return null;
}

/** The bottom timeline of a video project with survey dates: one lane per date. */
export function WorkspaceLanes() {
  const {
    project,
    playing,
    rate,
    activeClip,
    selectedIssue,
    model: base,
    index,
    focus,
    offset,
  } = useLaneSource();
  const projectId = project?.id ?? '';
  // folded dates open per project and close again when another project opens
  const [opened, setOpened] = useState({ project: '', earlier: false, later: false });
  const earlier = opened.project === projectId && opened.earlier;
  const later = opened.project === projectId && opened.later;
  const model = useMemo(
    () =>
      base && index ? buildLaneModel(base, index, focus, offset ?? 0, { earlier, later }) : null,
    [base, index, focus, offset, earlier, later],
  );
  const colours = useMemo(() => {
    const tags = index ? dateTags(index.captures) : {};
    return Object.fromEntries(Object.entries(tags).map(([id, tag]) => [id, tag.colour]));
  }, [index]);
  const focusedLane = model?.lanes.find((l) => l.captureId === model.focus);
  // stable callbacks: the memoized lanes then render only when something they show changes
  const onFocusLane = useCallback((id: string) => {
    timeline.getState().focusSurvey(id);
  }, []);
  const onExpand = useCallback(
    (side: 'earlier' | 'later') => {
      setOpened({ project: projectId, earlier, later, [side]: true });
    },
    [projectId, earlier, later],
  );
  const onClip = useCallback(
    (id: string, atMs?: number) => {
      // A clip bar selects its clip and seeks; Space or Play plays.
      const clip = model?.lanes.flatMap((l) => l.clips).find((c) => c.layerId === id);
      pickClip(id, atMs, clip);
    },
    [model],
  );
  const onStep = useCallback(
    (dir: 1 | -1) => {
      if (!focusedLane) return;
      const c = laneNeighbour(focusedLane, workspace.getState().activeClip, dir);
      if (!c) return;
      selectClip(c.layerId);
      workspace.getState().setTime(c.startMs);
    },
    [focusedLane],
  );
  const dateSlot = useMemo(() => <DatePicker up />, []);
  if (!model) return null;

  return (
    <LaneTimeline
      {...timelineActions}
      model={model}
      clock={clock}
      playing={playing}
      rate={rate}
      activeClip={activeClip}
      selectedIssue={selectedIssue}
      colours={colours}
      dateSlot={dateSlot}
      clockLabel={offsetLabel(offset)}
      onFocusLane={onFocusLane}
      onExpand={onExpand}
      onClip={onClip}
      onStep={onStep}
    />
  );
}
