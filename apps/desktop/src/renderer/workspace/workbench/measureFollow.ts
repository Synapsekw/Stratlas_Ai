/**
 * How the right sidebar follows the survey tools (stage island D13, D14, D18), without the bench UI:
 * `followMeasureTool` makes the Measure tab live while a tool draws, `linkPanelTab` keeps the
 * Survey QA, Terrain overlays and Hydrology tabs open exactly while their panels are, and
 * `followRecent` counts every tool start in "Favourites and recent".
 */
import { isTelecomTool } from '@aio/survey';
import { useEffect } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { isIssueEditing } from '../../issueCard/state';
import { roadStore, type RoadState } from '../../road/store';
import { hydro } from '../../survey/hydroStore';
import { measureFavourites, type FavouritesState } from '../../survey/measureCatalogue';
import { measureStore, stopTool, type MeasureState } from '../../survey/measureStore';
import { overlays, setOverlaysOpen } from '../../survey/overlaysStore';
import { openQaPanel, qaStore } from '../../survey/qaStore';
import { followTool, showBench } from './followTool';
import type { TabId } from './tabsModel';
import { linkLiveTab, workbench, type WorkbenchState } from './workbenchStore';

const BENCH: TabId = 'measure';

/** The sidebar tabs of the survey panels that a drawing can be for (D18). */
const PANEL_TABS: readonly TabId[] = ['qa', 'overlays', 'hydro'];

// ---------------------------------------------------------------- following the tools

/** Bring the Measure tab to the front, opening it when it is not there. */
function reveal(bench: StoreApi<WorkbenchState>): void {
  const b = bench.getState();
  if (b.front === BENCH) return;
  if (b.tabs.some((t) => t.id === BENCH)) b.show(BENCH);
  else b.open(BENCH);
}

/**
 * Open the Measure workbench (the island's Measure tab, its All tools tile). A folded sidebar
 * stays folded and the Measure tab shows in the workbench drawer (I-R40a).
 */
export function showMeasureBench(bench: StoreApi<WorkbenchState> = workbench): void {
  showBench(BENCH, bench);
}

/**
 * The sidebar follows the survey tools (D13, D14): a tool starting makes the Measure tab live (in
 * front unless an issue is being edited); stopping one that opened the tab closes it again. A
 * drawing for another panel (a one-shot shape, or one started from a survey panel's tab) leaves
 * that panel in front. Opening the measurements list, or picking a measurement while no tool
 * draws, brings the Measure tab forward. Closing the live tab with its X stops the drawing
 * (`linkLiveTab`). Returns unsubscribe.
 */
export function followMeasureTool(
  measure: StoreApi<MeasureState> = measureStore,
  bench: StoreApi<WorkbenchState> = workbench,
): () => void {
  let started = false;
  let focusAtStart: string | null = null;
  const follow = () => {
    if (!isIssueEditing()) reveal(bench);
  };
  const offTab = linkLiveTab(BENCH, () => measure.getState().tool !== null, stopTool, bench);
  const offTool = measure.subscribe((s, prev) => {
    if (s.tool && !prev.tool) {
      if (!s.tool.then && !PANEL_TABS.includes(bench.getState().front)) {
        started = true;
        focusAtStart = s.focus;
        // a tool start (D14); its drawing is on the stage, so the sidebar stays as it is
        followTool(BENCH, {}, bench);
      }
    } else if (!s.tool && prev.tool && started) {
      started = false;
      bench.getState().toolStopped(BENCH);
      // a telecom tool stops on its last pick: its reading stays in view
      if (isTelecomTool(prev.tool.tool) && s.focus && s.focus !== focusAtStart) follow();
    }
    if (s.listOpen && !prev.listOpen) follow();
    if (!s.tool && s.focus && s.focus !== prev.focus) follow();
  });
  return () => {
    offTab();
    offTool();
    // unmounted mid-drawing (the Scene left): the live tab is let go with it, as the road's is;
    // the Scene coming back stops the tool on mount, with no follower that saw it start
    if (started) bench.getState().toolStopped(BENCH);
  };
}

/**
 * Keep a survey panel's sidebar tab open exactly while the panel is (D18): the panel opening
 * opens its tab, closing it closes the tab, and the tab closed (or replaced) closes the panel.
 * Returns unsubscribe.
 */
export function linkPanelTab<S>(
  id: TabId,
  store: StoreApi<S>,
  isOpen: (s: S) => boolean,
  close: () => void,
  bench: StoreApi<WorkbenchState> = workbench,
): () => void {
  const has = () => bench.getState().tabs.some((t) => t.id === id);
  const sync = () => {
    const open = isOpen(store.getState());
    if (open && !has()) bench.getState().open(id);
    else if (!open && has()) bench.getState().close(id);
  };
  sync();
  const offStore = store.subscribe((s, prev) => {
    if (isOpen(s) !== isOpen(prev)) sync();
  });
  const offBench = bench.subscribe((s, prev) => {
    const had = prev.tabs.some((t) => t.id === id);
    const now = s.tabs.some((t) => t.id === id);
    if (had && !now && isOpen(store.getState())) close();
  });
  return () => {
    offStore();
    offBench();
  };
}

/**
 * The road's measure on the map is a tool (D14): while it draws the Road tab is live, in front
 * unless an issue is being edited, and it closes again when it opened for the tool. Whichever way
 * it starts (the island's tile, the Road workbench, the key). Unmounted mid-measure, the live tab
 * is let go too, so it never stays live with nothing following it. Returns unsubscribe.
 */
export function followRoadMeasure(
  road: Pick<StoreApi<RoadState>, 'subscribe'> = roadStore,
  bench: StoreApi<WorkbenchState> = workbench,
): () => void {
  let live = false;
  const off = road.subscribe((s, prev) => {
    const now = s.measure.mode !== null;
    if (now === (prev.measure.mode !== null)) return;
    live = now;
    if (now) bench.getState().toolStarted('road');
    else bench.getState().toolStopped('road');
  });
  return () => {
    off();
    if (live) bench.getState().toolStopped('road');
  };
}

/** While mounted: the Measure and Road tabs follow the tools, and the survey panels are tabs. */
export function useMeasureFollow(): void {
  useEffect(() => {
    const off = [
      followMeasureTool(),
      followRoadMeasure(),
      followRecent(),
      linkPanelTab(
        'overlays',
        overlays,
        (s) => s.open,
        () => {
          setOverlaysOpen(false);
        },
      ),
      linkPanelTab(
        'qa',
        qaStore,
        (s) => s.panel !== null,
        () => {
          openQaPanel(null);
        },
      ),
      linkPanelTab(
        'hydro',
        hydro,
        (s) => s.open,
        () => {
          hydro.setState({ open: false });
        },
      ),
    ];
    return () => {
      for (const o of off) o();
    };
  }, []);
}

/**
 * Every tool start counts in "recent" (D12), whichever way it came: M, the island's tiles, the
 * bench, a template. One-shot drawings for another panel do not. Returns unsubscribe.
 */
export function followRecent(
  measure: StoreApi<MeasureState> = measureStore,
  favourites: StoreApi<FavouritesState> = measureFavourites,
): () => void {
  return measure.subscribe((s, prev) => {
    if (!s.tool || s.tool.then) return;
    if (prev.tool?.tool === s.tool.tool && !prev.tool.then) return;
    favourites.getState().used(s.tool.tool);
  });
}
