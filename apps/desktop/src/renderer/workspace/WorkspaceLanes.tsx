import { buildLaneModel, LaneTimeline, laneNeighbour, offsetLabel } from '@aio/ui';
import { dateTags, workspace } from '@aio/workspace';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  const { project, nowMs, model: base, index, focus, offset } = useLaneSource();
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
    nowMs,
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
  if (!model) return null;
  const focusedLane = model.lanes.find((l) => l.captureId === model.focus);

  return (
    <LaneTimeline
      {...timelineActions}
      model={model}
      nowMs={nowMs}
      playing={playing}
      rate={rate}
      activeClip={activeClip}
      selectedIssue={selectedIssue}
      colours={colours}
      dateSlot={<DatePicker up />}
      clockLabel={offsetLabel(offset)}
      onFocusLane={(id) => {
        timeline.getState().focusSurvey(id);
      }}
      onExpand={(side) => {
        setOpened({ project: projectId, earlier, later, [side]: true });
      }}
      onClip={(id, atMs) => {
        // A clip bar selects its clip and seeks; Space or Play plays.
        const clip = model.lanes.flatMap((l) => l.clips).find((c) => c.layerId === id);
        pickClip(id, atMs, clip);
      }}
      onStep={(dir) => {
        if (!focusedLane) return;
        const c = laneNeighbour(focusedLane, workspace.getState().activeClip, dir);
        if (!c) return;
        selectClip(c.layerId);
        workspace.getState().setTime(c.startMs);
      }}
    />
  );
}
