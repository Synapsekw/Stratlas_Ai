/**
 * What the workbench shows, without the sidebar or its benches (stage island D10, D11): the tabs
 * and the front one, the tab each kind of live item lives in, and whether the island shows as
 * linked. Small on purpose: the Stage and the island import it, so they do not pull the whole
 * sidebar and every bench into their module graph.
 */
import { useVolumetric } from '@aio/volumetric';
import { canCompare, useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useCaptureIndex } from '../compare';
import { pickLive, type LiveItem, type ToolSource } from '../island/islandModel';
import { useIslandLive } from '../island/useIslandLive';
import type { Tab, TabId } from './tabsModel';
import { useWorkbench } from './workbenchStore';

/**
 * The tab each kind of live item lives in (D11), a tool by whose it is; the connection has none.
 * One map for both ends: the island's click on its live reading (D10) and the sidebar's linked
 * outline must agree.
 */
export const LIVE_TAB: Readonly<
  Record<Exclude<LiveItem['kind'], 'tool'> | ToolSource, TabId | null>
> = {
  measure: 'measure',
  road: 'road',
  annotate: 'annotate',
  playback: 'video',
  job: 'jobs',
  connection: null,
};

/** The tab a live item lives in, or null for one with none (the connection). */
export function liveTab(item: LiveItem): TabId | null {
  return LIVE_TAB[item.kind === 'tool' ? (item.source ?? 'measure') : item.kind];
}

/** The island is linked when the sidebar's front tab is its primary live item's tab (D10). */
export function islandLinked(front: TabId, primary: LiveItem | null): boolean {
  return primary !== null && liveTab(primary) === front;
}

const SELECTION: Tab = { id: 'selection', live: false, pinned: false, fixed: true };

/**
 * The tabs the sidebar shows and the one in front: Volumes only in a volumetric project and
 * Changes only with two dates to compare, as before; a front tab that is not shown is Selection.
 */
export function useWorkbenchView(): { tabs: Tab[]; front: Tab } {
  const all = useWorkbench((s) => s.tabs);
  const chosen = useWorkbench((s) => s.front);
  const volumes = useVolumetric((s) => s.status !== 'none' && s.status !== 'idle');
  const captureIx = useCaptureIndex();
  const dated = captureIx !== null && canCompare(captureIx);
  const tabs = useMemo(
    () =>
      all.filter((tab) => (tab.id === 'volumes' ? volumes : tab.id === 'changes' ? dated : true)),
    [all, volumes, dated],
  );
  // the cloud tabs only where the project has a cloud (D6)
  const clouds = useWorkspace((s) =>
    (s.project?.manifest.layers ?? []).some((l) => l.kind === 'pointcloud'),
  );
  const shown = useMemo(
    () => (clouds ? tabs : tabs.filter((tab) => tab.id !== 'clouds' && tab.id !== 'cleanup')),
    [tabs, clouds],
  );
  const front = shown.find((tab) => tab.id === chosen) ?? SELECTION;
  return { tabs: shown, front };
}

/** Whether the island shows as linked to the sidebar (`linked` on `<Island>`). */
export function useIslandLinked(): boolean {
  const { front } = useWorkbenchView();
  const { primary } = pickLive(useIslandLive());
  return islandLinked(front.id, primary);
}
