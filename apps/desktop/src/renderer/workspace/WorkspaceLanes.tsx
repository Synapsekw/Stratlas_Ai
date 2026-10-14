import { buildLaneModel, LaneTimeline, laneNeighbour, offsetLabel } from '@aio/ui';
import { dateTags, workspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { DatePicker } from './DatePicker';
import { siteOffset } from './lanes';
import { pickClip, selectClip } from './pickClip';
import { timeline, useTimeline } from './timeline';
import { timelineActions, useTimelineBinding } from './timelineBinding';

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
  } = useTimelineBinding();
  const index = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  const projectId = project?.id ?? '';
  // folded dates open per project and close again when another project opens
  const [opened, setOpened] = useState({ project: '', earlier: false, later: false });
  const earlier = opened.project === projectId && opened.earlier;
  const later = opened.project === projectId && opened.later;
  const offset = useMemo(() => (project ? siteOffset(project.manifest) : null), [project]);
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
      hideKeys="T"
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
