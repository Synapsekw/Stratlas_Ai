import type { Lane, LaneClip } from '@aio/ui';
import { captureIndex, workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { followLaneFocus, type LaneView } from './laneFocus';
import { timeline } from './timeline';

const MIN = 60_000;
const H = 60 * MIN;
const midnight = (date: string) => Date.parse(`${date}T00:00:00Z`);
const bar = (layerId: string, date: string, startTod: number, len: number): LaneClip => ({
  layerId,
  name: layerId,
  startMs: midnight(date) + startTod,
  endMs: midnight(date) + startTod + len,
  estimated: false,
  group: layerId,
  startTod,
  endTod: startTod + len,
  row: 0,
});
const lane = (captureId: string, date: string, clips: LaneClip[]): Lane => ({
  captureId,
  date,
  label: captureId,
  clips,
  rows: clips.length ? 1 : 0,
  issues: [],
  photos: [],
});
// site time is UTC here (offset 0): sep and nov have a clip at 09:00 / 09:05, oct only at 10:00
const LANES = [
  lane('sep', '2024-09-04', [bar('clip-sep', '2024-09-04', 9 * H, 10 * MIN)]),
  lane('oct', '2024-10-02', [bar('clip-oct', '2024-10-02', 10 * H, 10 * MIN)]),
  lane('nov', '2024-11-06', [bar('clip-nov', '2024-11-06', 9 * H + 5 * MIN, 10 * MIN)]),
];

let view: LaneView;
let stop: () => void = () => undefined;
beforeEach(() => {
  timeline.setState({ byProject: {} });
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  timeline.getState().attach('p3', captureIndex(threeDates));
  timeline.getState().focusSurvey('nov');
  workspace.getState().setActiveClip('clip-nov');
  workspace.getState().setTime(midnight('2024-11-06') + 9 * H + 7 * MIN);
  // the clock as last drawn, before a focus change moves anything
  view = { projectId: 'p3', lanes: LANES, offsetMin: 0, nowMs: workspace.getState().nowMs };
  stop = followLaneFocus(() => view);
});
afterEach(() => {
  stop();
  timeline.getState().attach(null, null);
  workspace.getState().closeProject();
});

describe('followLaneFocus', () => {
  it('puts the clock on the same time of day in the new date’s clip, without playing', () => {
    timeline.getState().focusSurvey('sep');
    const ws = workspace.getState();
    expect(ws.nowMs).toBe(midnight('2024-09-04') + 9 * H + 7 * MIN);
    expect(ws.activeClip).toBe('clip-sep');
    expect(ws.playing).toBe(false);
  });
  it('in a gap, keeps the time of day and no clip of another date', () => {
    timeline.getState().focusSurvey('oct');
    const ws = workspace.getState();
    expect(ws.nowMs).toBe(midnight('2024-10-02') + 9 * H + 7 * MIN);
    // the active clip, if any, is the new date's
    expect(ws.activeClip === null || ws.activeClip === 'clip-oct').toBe(true);
  });
  it('lets a seek after the focus change win (a drag into another lane)', () => {
    const dragged = midnight('2024-09-04') + 9 * H + 3 * MIN;
    timeline.getState().focusSurvey('sep');
    workspace.getState().setTime(dragged);
    expect(workspace.getState().nowMs).toBe(dragged);
  });
  it('stops following once released', () => {
    stop();
    const before = workspace.getState().nowMs;
    timeline.getState().focusSurvey('oct');
    // the date step alone does not map the time of day
    expect(workspace.getState().nowMs).not.toBe(midnight('2024-10-02') + 9 * H + 7 * MIN);
    expect(before).toBeGreaterThan(0);
  });
});
