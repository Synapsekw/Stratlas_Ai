/**
 * The right sidebar as the workbench (stage island D11, D14, D17): the header row, one row of
 * tabs (live activities, the open workbench or tool panel, then Selection, Issues, Volumes and
 * Changes), the front tab's body, and the agent below it on the `scene.ctxAgent` split. The width
 * is the `scene.right` split's, dragged on the inner edge and remembered; a tab may ask for more
 * (Volumes and Changes, 470 px) while it is in front.
 */
import { IssueRegister } from '@aio/annotate';
import { Button, IconButton, useResizableSplit, useT } from '@aio/ui';
import { useVolumetric } from '@aio/volumetric';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type AnimationEvent,
  type TransitionEvent,
} from 'react';
import { useStore } from 'zustand';
import { ChangesTab, useChangesTabSeq } from '../../change';
import { IssueCard } from '../../issueCard/IssueCard';
import { useCardFocusSeq } from '../../issueCard/state';
import { useModeller } from '../../modeller';
import { RoadPanel } from '../../road/RoadPanel';
import { RoadSetupCard } from '../../road/RoadSetup';
import { useIsRoad } from '../../road/useRoadMap';
import { shell, useShell } from '../../shell';
import { PANEL_ID } from '../../shell/PanelHandle';
import { RightHeader } from '../../shell/RightHeader';
import { useFold } from '../../shell/useFold';
import { agentWindow } from '../agentWindow';
import { SelectionCard } from '../SelectionCard';
// Measure bench
import { HydroTab } from '../../survey/Hydro';
import { OverlaysPanel } from '../../survey/Overlays';
import { QaSide } from '../../survey/Qa';
import { MeasureBench } from './benches/MeasureBench';
import { sectionStore, useSections } from './sectionState';
import { TabBar } from './TabBar';
import type { TabId } from './tabsModel';
import { useDrawer } from './drawerStore';
import { useWorkbenchView } from './view';
import { useWorkbench, workbench } from './workbenchStore';
// Road, Volumes and environment benches
import { EnvironmentTab } from '../../environment/EnvironmentTool';
import { CutawayTab } from '../CutawayTool';
import { RoadBench } from './benches/RoadBench';
import { VolumesBench } from './benches/VolumesBench';
// Display and Point cloud benches
import { CleanupTab } from '../../pointcloud/CleanupTab';
import { useBenchFollow } from './benchFollow';
import { CloudBench } from './benches/CloudBench';
import { DisplayBench } from './benches/DisplayBench';
// Video, Annotate and Jobs benches
import { AnnotateBench, useAnnotateFollow } from './benches/AnnotateBench';
import { JobsBench } from './benches/JobsBench';
import { VideoBench } from './benches/VideoBench';
// Engineering model review: self-contained content in the standard workbench.
import { ReviewBench } from './benches/ReviewBench';
// Agent pane: the agent below the bench, maximised, minimised or off (Task 18)
import { AgentPane } from '../../agent/AgentPane';
import { agentPane } from '../../agent/agentPaneStore';
// RF coverage bench (rf-coverage T9)
import { RfBench } from './benches/RfBench';
import './workbench.css';

/** The strip the right panel folds to: its border and the 12 px tab (`--ph-w`), as before. */
const RIGHT_STRIP = 13;
const RIGHT_MIN = 280;

/**
 * The stage and the right sidebar on the `scene.right` split: the sidebar's width is the grid's
 * second column, dragged on its inner edge and remembered; folded (Ctrl+Alt+B, the tab, or a
 * drag), it is the 12 px strip. The sidebar slides with a transform and the grid snaps once, so
 * the 3D view and the map are resized once (shell/useFold.ts). A front tab with a minimum width
 * raises the split's minimum while it is in front; the remembered width is left as it was.
 */
export function useSidebarSplit(collapsed: boolean, hasProject: boolean) {
  const fold = useFold(collapsed);
  const { snap } = fold;
  const { front } = useWorkbenchView();
  const split = useResizableSplit({
    id: 'scene.right',
    orientation: 'horizontal',
    sized: 'end',
    unit: 'px',
    defaultSize: 360,
    min: Math.max(RIGHT_MIN, front.minWidth ?? 0),
    // a wide tab holds the drag at its minimum; the panel still folds where it always does
    collapseMin: RIGHT_MIN,
    max: '50%',
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
 * The front follows what the person does, as the context tabs did: a picked issue shows its card
 * in Selection, Show changes brings Changes, and a volumetric project opens on Volumes.
 */
function useFollow(front: TabId) {
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
  const volumes = useVolumetric((s) => s.status !== 'none' && s.status !== 'idle');
  // once per project: another volumetric project opened straight after this one opens on its own
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const seenVolumes = useRef<string | null>(null);
  useEffect(() => {
    if (!volumes || !projectId) {
      seenVolumes.current = null;
      return;
    }
    if (seenVolumes.current === projectId) return;
    seenVolumes.current = projectId;
    if (front === 'selection') workbench.getState().show('volumes');
  }, [volumes, projectId, front]);
}

/** A workbench's header row: Collapse all or Expand all, one icon button (D16). */
function BenchHead({ bench }: { bench: TabId }) {
  const t = useT();
  const sections = useSections(bench);
  const folded = useStore(sectionStore, (s) => s.byBench[bench]?.all === false);
  return (
    <div className="wb-bench-head">
      <IconButton
        icon={folded ? 'chevdown' : 'chevup'}
        label={folded ? t('wb.expandAll') : t('wb.collapseAll')}
        onClick={() => {
          if (folded) sections.expandAll();
          else sections.collapseAll();
        }}
      />
    </div>
  );
}

/**
 * The note beside a tab that waits behind an issue being edited (D14, I-R52): its name and
 * "Show it", which brings it to the front. Only while the waiting tab is shown and not in front.
 */
export function ShowIt({ tabs, front }: { tabs: readonly { id: TabId }[]; front: TabId }) {
  const t = useT();
  const attention = useWorkbench((s) => s.attention);
  if (!attention || attention === front || !tabs.some((tab) => tab.id === attention)) return null;
  return (
    <div className="wb-show-it" role="status" data-testid="wb-show-it">
      <span>{t(`wb.tab.${attention}`)}</span>
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

/** What the front tab shows: today's context content for the fixed tabs. */
export function FrontBody({ front, road }: { front: TabId; road: boolean }) {
  const issueId = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  if (front === 'volumes') return <VolumesBench />;
  if (front === 'changes') return <ChangesTab className="ctx-fill" />;
  if (front === 'issues') return <IssueRegister className="ctx-fill" />;
  if (front === 'selection') {
    if (road) return <RoadPanel />;
    if (issueId) return <IssueCard issueId={issueId} place="scene" className="ctx-fill" />;
    return <SelectionCard />;
  }
  // Road, Volumes and environment benches
  if (front === 'road')
    return (
      <>
        <BenchHead bench="road" />
        <RoadBench />
      </>
    );
  if (front === 'environment') return <EnvironmentTab />;
  if (front === 'cutaway') return <CutawayTab />;
  // Display and Point cloud benches
  if (front === 'cleanup') return <CleanupTab />;
  if (front === 'display' || front === 'clouds') {
    return (
      <>
        <BenchHead bench={front} />
        {front === 'display' ? <DisplayBench /> : <CloudBench />}
      </>
    );
  }
  // Video, Annotate and Jobs benches
  if (front === 'jobs') return <JobsBench />;
  if (front === 'video' || front === 'annotate') {
    return (
      <>
        <BenchHead bench={front} />
        {front === 'video' ? <VideoBench /> : <AnnotateBench />}
      </>
    );
  }
  // Measure bench: the bench, and the survey panels it opens as tabs (D18)
  if (front === 'measure')
    return (
      <>
        <BenchHead bench={front} />
        <MeasureBench />
      </>
    );
  if (front === 'qa') return <QaSide />;
  if (front === 'overlays') return <OverlaysPanel />;
  // Engineering model review: uses the same section controls and drawer as other benches.
  if (front === 'review')
    return (
      <>
        <BenchHead bench={front} />
        <ReviewBench />
      </>
    );
  // RF coverage bench (rf-coverage T9): the Site, Sector and Results sections (spec D21)
  if (front === 'rf')
    return (
      <>
        <BenchHead bench={front} />
        <RfBench />
      </>
    );
  return lastBody(front);
}

/** The one tab left once every other has its body above: a new TabId without one fails here. */
function lastBody(front: 'hydro') {
  return <HydroTab key={front} />;
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
  const { tabs, front } = useWorkbenchView();
  useFollow(front.id);
  useBenchFollow();
  // Video, Annotate and Jobs benches: Annotate opens its tab when the tools start
  useAnnotateFollow();
  const issues = useWorkspace((s) => s.issues.length);
  const piles = useVolumetric((s) => s.piles.length);
  const issueOpen = useWorkspace((s) => s.selection?.kind === 'issue');
  const id = front.id;
  const tall = id !== 'selection' || issueOpen || road;
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
      {/* the workbench's heading, so the agent's h3 below the bench follows an h2 (I-R45) */}
      <h2 className="sr-only wb-heading">{t('wb.heading')}</h2>
      <TabBar
        tabs={tabs}
        front={id}
        counts={{ issues, volumes: piles }}
        onShow={(tab) => {
          workbench.getState().show(tab);
          // a tab clicked over the maximised agent brings the workbench back (D22)
          if (agentPane.getState().mode === 'max') agentPane.getState().setMode('normal');
        }}
        onPin={(tab, on) => {
          workbench.getState().pin(tab, on);
        }}
        onClose={(tab) => {
          workbench.getState().close(tab);
        }}
      />
      <ShowIt tabs={tabs} front={id} />
      <AgentPane
        window={focused}
        task={modellerOpen || id === 'review' ? 'build' : undefined}
        bench={
          <>
            {!road && <RoadSetupCard />}
            <div
              className={`ctx-wrap wb-body${tall ? ' tall' : ''}${id === 'volumes' ? ' vol' : ''}`}
              role="tabpanel"
              id={`wb-panel-${id}`}
              aria-labelledby={`wb-tab-${id}`}
              data-front={id}
            >
              {/* the drawer shows the bench while this panel is folded away (I-R38) */}
              {deferBody ? null : <FrontBody front={id} road={road} />}
            </div>
          </>
        }
      />
    </aside>
  );
}
