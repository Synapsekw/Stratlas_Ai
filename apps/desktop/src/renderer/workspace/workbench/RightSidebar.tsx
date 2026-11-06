/**
 * The right panel (UI revision D2; stage island D14): the header row, four fixed tabs (Selection,
 * Tools, Layers & display, Project), the tab's body (Selection's card, or the tab's sections) and
 * the agent below it on the `scene.ctxAgent` split. One width per window band, dragged on the
 * inner edge and remembered per band; opening a tab or a section never changes it, only "Expand
 * panel" on a wide tool does while it is pressed.
 */
import { Button, useResizableSplit, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type AnimationEvent,
  type TransitionEvent,
} from 'react';
import { useChangesTabSeq } from '../../change';
import { useCardFocusSeq } from '../../issueCard/state';
import { useModeller } from '../../modeller';
import { RoadSetupCard } from '../../road/RoadSetup';
import { useIsRoad } from '../../road/useRoadMap';
import { shell, useShell } from '../../shell';
import { PANEL_ID } from '../../shell/PanelHandle';
import { RightHeader } from '../../shell/RightHeader';
import { useFold } from '../../shell/useFold';
import { agentWindow } from '../agentWindow';
import { useBenchFollow } from './benchFollow';
import { useAnnotateFollow } from './benches/AnnotateBench';
import { useDrawer } from './drawerStore';
import { chooseTab } from '../../layout/useApplyPreset';
import { useSelectionShows } from './FrontBody';
import { migrateOldRightWidth, rightSplit, usePanelBand } from './panelWidth';
import { TabBar } from './TabBar';
import { LayersDisplayTab } from './tabs/LayersDisplayTab';
import { ProjectTab } from './tabs/ProjectTab';
import { SelectionTab } from './tabs/SelectionTab';
import { ToolsTab } from './tabs/ToolsTab';
import { sectionDef, sectionFor, tabOfSection, type PanelTab, type TabId } from './tabsModel';
import { useWorkbenchView } from './view';
import { useWorkbench, workbench } from './workbenchStore';
// Agent pane: the agent below the panel's body, maximised, minimised or off (Task 18)
import { AgentPane } from '../../agent/AgentPane';
import { agentPane } from '../../agent/agentPaneStore';
import './workbench.css';

// a width dragged before the bands is carried into the wide band, once
migrateOldRightWidth();

// the bodies moved to FrontBody.tsx; re-exported for the drawer
export { FrontBody } from './FrontBody';

/** The strip the right panel folds to: its border and the 12 px tab (`--ph-w`), as before. */
const RIGHT_STRIP = 13;

/**
 * The stage and the right panel on the band's split (`scene.right.<band>`): the panel's width is
 * the grid's second column, dragged on its inner edge and remembered per band; folded (Ctrl+Alt+B,
 * the tab, or a drag), it is the 12 px strip. The panel slides with a transform and the grid snaps
 * once, so the 3D view and the map are resized once (shell/useFold.ts). "Expand panel" raises the
 * minimum to the band's widest while it is pressed; the remembered width is left as it was.
 */
export function useSidebarSplit(collapsed: boolean, hasProject: boolean) {
  const fold = useFold(collapsed);
  const { snap } = fold;
  const band = usePanelBand();
  const expanded = useWorkbench((s) => s.expanded);
  const limits = rightSplit(band, expanded);
  const split = useResizableSplit({
    id: limits.id,
    orientation: 'horizontal',
    sized: 'end',
    unit: 'px',
    defaultSize: limits.defaultSize,
    min: limits.min,
    // an expanded panel holds the drag at its width; the panel still folds where it always does
    collapseMin: rightSplit(band, false).min,
    max: limits.max,
    otherMin: 360,
    collapsedSize: RIGHT_STRIP,
    collapsed: fold.layoutFolded,
    onCollapsedChange: (next) => {
      snap(next);
      shell.getState().setRight(next);
    },
  });
  const { settle, phase } = fold;
  const { containerRef } = split;
  // The tab slides as far as the panel: its open width less the strip, measured in px when the
  // slide starts (the column's width is a clamp with percentages, which mean the tab's own box
  // inside a transform). Opening, the grid has already snapped open here.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const panel = el?.querySelector(':scope > .right');
    if (!el || !panel || !phase) return;
    const open = panel.getBoundingClientRect().width;
    el.style.setProperty('--rp-fold-dx', `${String(Math.max(0, open - RIGHT_STRIP))}px`);
  }, [phase, containerRef]);
  // The panel's live width, for what is placed beside it outside the Scene (the Model builder):
  // `--rp-live` on `.app`, following drags without a render.
  useEffect(() => {
    const el = containerRef.current;
    const panel = el?.querySelector(':scope > .right');
    const app = el?.closest<HTMLElement>('.app');
    if (!panel || !app || typeof ResizeObserver === 'undefined') return;
    const write = () => {
      app.style.setProperty(
        '--rp-live',
        `${String(Math.round(panel.getBoundingClientRect().width))}px`,
      );
    };
    write();
    const watch = new ResizeObserver(write);
    watch.observe(panel);
    return () => {
      watch.disconnect();
      app.style.removeProperty('--rp-live');
    };
  }, [hasProject, containerRef]);
  // the panel's slide ended (not one of the many transitions inside it)
  const onSlideEnd = (e: TransitionEvent | AnimationEvent) => {
    if ((e.target as Element).classList.contains('right')) settle();
  };
  return {
    phase,
    containerRef,
    separatorProps: split.separatorProps,
    onTransitionEnd: (e: TransitionEvent) => {
      if (e.propertyName === 'transform') onSlideEnd(e);
    },
    onAnimationEnd: onSlideEnd,
  };
}

/**
 * The panel follows what the person does, as the context tabs did: a picked issue shows its card
 * in Selection and Show changes brings Project > Changes. What a project opens on is its layout
 * preset's (layout/useApplyPreset.ts).
 */
function useFollow() {
  const focusSeq = useCardFocusSeq();
  const seenFocus = useRef(focusSeq);
  useEffect(() => {
    if (seenFocus.current === focusSeq) return;
    seenFocus.current = focusSeq;
    workbench.getState().show('selection');
  }, [focusSeq]);
  const changesSeq = useChangesTabSeq();
  const seenChanges = useRef(changesSeq);
  useEffect(() => {
    if (seenChanges.current === changesSeq) return;
    seenChanges.current = changesSeq;
    workbench.getState().show('changes');
  }, [changesSeq]);
}

/**
 * The note for a tool waiting behind an issue being edited (D14, I-R52): its name and "Show it",
 * which brings it forward. Only while the waiting tool is not in front.
 */
export function ShowIt({ front }: { front: TabId }) {
  const t = useT();
  const attention = useWorkbench((s) => s.attention);
  const noted = useWorkbench((s) => s.noteSection);
  if (!attention || attention === front) {
    if (!noted) return null;
    // a section with news that did not come forward (a finished detection run)
    return (
      <div className="wb-show-it" role="status" data-testid="wb-show-it">
        <span>{t(sectionDef(noted)?.label ?? 'wb.heading')}</span>
        <Button
          variant="quiet"
          onClick={() => {
            workbench.getState().show(tabOfSection(noted), noted);
          }}
        >
          {t('wb.showIt')}
        </Button>
      </div>
    );
  }
  return (
    <div className="wb-show-it" role="status" data-testid="wb-show-it">
      {/* the name of the section it waits in (Measure, not the old tab's "Project") */}
      <span>{t(sectionDef(sectionFor(attention).section)?.label ?? `wb.tab.${attention}`)}</span>
      <Button
        variant="quiet"
        onClick={() => {
          workbench.getState().show(attention);
        }}
      >
        {t('wb.showIt')}
      </Button>
    </div>
  );
}

/** The four tabs that hold a live tool or activity (a dot on the tab). */
function useLiveTabs(): ReadonlySet<PanelTab> {
  const key = useWorkbench((s) =>
    s.tabs
      .filter((x) => x.live)
      .map((x) => sectionFor(x.id).tab)
      .join(','),
  );
  return useMemo(() => new Set(key.split(',').filter(Boolean) as PanelTab[]), [key]);
}

/** The front tab's body. */
function PanelBody({ tab }: { tab: PanelTab }) {
  if (tab === 'tools') return <ToolsTab />;
  if (tab === 'layers') return <LayersDisplayTab />;
  if (tab === 'project') return <ProjectTab />;
  return <SelectionTab />;
}

export function RightSidebar() {
  const t = useT();
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  const drawerPresent = useDrawer((s) => s.present);
  const drawerOpened = useDrawer((s) => s.opened);
  const focusedWindow = useWorkspace((s) => s.focusedWindow);
  const stageMode = useShell((s) => s.stageMode);
  const focused = agentWindow(focusedWindow, stageMode);
  // The Model builder and engineering review use the build route (C5).
  const modellerOpen = useModeller((s) => s.open);
  const road = useIsRoad();
  const { front } = useWorkbenchView();
  const tab = useWorkbench((s) => s.panel);
  useFollow();
  useBenchFollow();
  // Video, Annotate and Jobs benches: Annotate opens its section when the tools start
  useAnnotateFollow();
  const issues = useWorkspace((s) => s.issues.filter((i) => i.status !== 'closed').length);
  const live = useLiveTabs();
  const id = front.id;
  // Selection's hint or a selected thing's card stands at its own height, the agent below taking
  // the rest; a pile, a measurement, an issue, the road and the other tabs get the tall share
  const shows = useSelectionShows(road);
  const tall = tab !== 'selection' || (shows !== 'empty' && shows !== 'card');
  const vol = tab === 'selection' && shows === 'pile';
  // Engineering comparison effects must have one owner through both drawer handoffs:
  // opened covers its first render; present includes the slide-out after sidebar expansion.
  const deferBody =
    id === 'review'
      ? drawerPresent || (rightCollapsed && drawerOpened !== null)
      : rightCollapsed && drawerPresent;
  return (
    <aside
      className="right"
      id={PANEL_ID.right}
      aria-label={t('wb.sidebar')}
      aria-hidden={rightCollapsed}
      inert={rightCollapsed}
    >
      <RightHeader />
      {/* the panel's heading, so the agent's h3 below it follows an h2 (I-R45) */}
      <h2 className="sr-only wb-heading">{t('wb.heading')}</h2>
      <TabBar
        front={tab}
        counts={{ project: issues }}
        live={live}
        onShow={(next) => {
          workbench.getState().show(next);
          // the person's tab for this project from now on (layout/layoutStore.ts)
          chooseTab(next);
          // a tab clicked over the maximised agent brings the panel back (D22)
          if (agentPane.getState().mode === 'max') agentPane.getState().setMode('normal');
        }}
      />
      <ShowIt front={id} />
      <AgentPane
        window={focused}
        task={modellerOpen || id === 'review' ? 'build' : undefined}
        bench={
          <>
            {!road && <RoadSetupCard />}
            <div
              className={`ctx-wrap wb-body${tall ? ' tall' : ''}${vol ? ' vol' : ''} wb-panel-body`}
              role="tabpanel"
              id={`wb-panel-${tab}`}
              aria-labelledby={`wb-tab-${tab}`}
              data-front={tab}
            >
              {/* the drawer shows the body while this panel is folded away (I-R38) */}
              <div className="wb-panel-scroll">{deferBody ? null : <PanelBody tab={tab} />}</div>
            </div>
          </>
        }
      />
    </aside>
  );
}
