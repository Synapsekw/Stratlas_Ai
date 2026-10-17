/**
 * What the island opens in the right sidebar (stage island D4, D10, D12, D14): each group's
 * workbench, the panel tabs its caret tiles open, the tab of the live item a click on the island
 * brings back, and the Road tab while the road's measure on the map draws.
 */
import type { StoreApi } from 'zustand/vanilla';
import { roadStore, type RoadState } from '../../road/store';
import { showBench } from '../workbench/followTool';
import type { TabId } from '../workbench/tabsModel';
import { workbench, type WorkbenchState } from '../workbench/workbenchStore';
import type { GroupId, LiveItem } from './islandModel';

/** Each group's workbench; View has none (its tiles and caret panels are the whole group). */
export const GROUP_TAB: Record<GroupId, TabId | null> = {
  view: null,
  measure: 'measure',
  display: 'display',
  clouds: 'clouds',
  volumes: 'volumes',
  video: 'video',
  road: 'road',
  annotate: 'annotate',
};

/** The tab each kind of live item lives in (D11); the connection has none. */
export function liveTab(item: LiveItem): TabId | null {
  switch (item.kind) {
    case 'tool':
      return 'measure';
    case 'playback':
      return 'video';
    case 'job':
      return 'jobs';
    case 'connection':
      return null;
  }
}

/**
 * An open the person makes from the island (a group, a tile, All tools): the tab comes to the
 * front of the workbench, opened as an unpinned panel (D15) when it is not there yet. The island
 * never unfolds the sidebar (rulings I-R40, I-R40a): a folded sidebar shows the tab in the
 * workbench drawer (`showBench`).
 */
export function openBenchFromIsland(id: TabId, bench: StoreApi<WorkbenchState> = workbench): void {
  showBench(id, bench);
}

/**
 * The road's measure on the map is a tool (D14): while it draws the Road tab is live, in front
 * unless an issue is being edited, and it closes again when it opened for the tool. Whichever way
 * it starts (the island's tile, the Road workbench, the key). Returns unsubscribe.
 */
export function followRoadMeasure(
  road: Pick<StoreApi<RoadState>, 'subscribe'> = roadStore,
  bench: StoreApi<WorkbenchState> = workbench,
): () => void {
  return road.subscribe((s, prev) => {
    const now = s.measure.mode !== null;
    if (now === (prev.measure.mode !== null)) return;
    if (now) bench.getState().toolStarted('road');
    else bench.getState().toolStopped('road');
  });
}
