/**
 * What the island opens in the right sidebar (stage island D4, D10, D12, D14): each group's
 * workbench and the panel tabs its caret tiles open. The tab of the live item a click on the
 * island brings back is `liveTab` (view.ts); the Road tab's tool follow is `followRoadMeasure`
 * (measureFollow.ts).
 */
import type { StoreApi } from 'zustand/vanilla';
import { showBench } from '../workbench/followTool';
import { requestToolsScroll } from '../workbench/project/projectListStore';
import type { TabId } from '../workbench/tabsModel';
import { workbench, type WorkbenchState } from '../workbench/workbenchStore';
import type { GroupId } from './islandModel';

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

/**
 * An open the person makes from the island (a group, a tile, All tools): the tab comes to the
 * front of the workbench, opened as an unpinned panel (D15) when it is not there yet. The island
 * never unfolds the sidebar (rulings I-R40, I-R40a): a folded sidebar shows the tab in the
 * workbench drawer (`showBench`). The Project tab (`measure`) opens scrolled so its TOOLS caption
 * is at the top, so a tool is no further away than before the "In this project" list.
 */
export function openBenchFromIsland(id: TabId, bench: StoreApi<WorkbenchState> = workbench): void {
  if (id === 'measure') requestToolsScroll();
  showBench(id, bench);
}
