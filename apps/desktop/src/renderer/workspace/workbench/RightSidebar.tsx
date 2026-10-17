/**
 * The right sidebar as the workbench (stage island D11, D14, D17): the header row, one row of
 * tabs (live activities, the open workbench or tool panel, then Selection, Issues, Volumes and
 * Changes), the front tab's body, and the agent below it on the `scene.ctxAgent` split. The width
 * is the `scene.right` split's, dragged on the inner edge and remembered; a tab may ask for more
 * (Volumes and Changes, 470 px) while it is in front.
 */
import { IssueRegister } from '@aio/annotate';
import { IconButton, ResizableSplit, splitPrefs, useResizableSplit, useT } from '@aio/ui';
import { useVolumetric, VolumesPanel } from '@aio/volumetric';
import { canCompare, useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent,
  type ReactNode,
  type TransitionEvent,
} from 'react';
import { useStore } from 'zustand';
import { AgentHost } from '../../agent/AgentHost';
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
import { TelecomTools } from '../../survey/TelecomTools';
import { agentWindow } from '../agentWindow';
import { useCaptureIndex } from '../compare';
import { pickLive, type LiveItem } from '../island/islandModel';
import { useIslandLive } from '../island/useIslandLive';
import { SelectionCard } from '../SelectionCard';
import { sectionStore, useSections } from './sectionState';
import { TabBar } from './TabBar';
import type { Tab, TabId } from './tabsModel';
import { useWorkbench, workbench } from './workbenchStore';
import './workbench.css';

/** The workbenches with collapsible sections, whose header holds Collapse all (D16). */
const BENCHES: readonly TabId[] = ['measure', 'display', 'clouds', 'video', 'road', 'annotate'];

/** The tab each kind of live item lives in (D11); the connection has none. */
const LIVE_TAB: Partial<Record<LiveItem['kind'], TabId>> = {
  tool: 'measure',
  playback: 'video',
  job: 'jobs',
};

/** The island is linked when the sidebar's front tab is its primary live item's tab (D10). */
export function islandLinked(front: TabId, primary: LiveItem | null): boolean {
  return primary !== null && LIVE_TAB[primary.kind] === front;
}

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
  const front = tabs.find((tab) => tab.id === chosen) ?? SELECTION;
  return { tabs, front };
}
const SELECTION: Tab = { id: 'selection', live: false, pinned: false, fixed: true };

/** Whether the island shows as linked to the sidebar (`linked` on `<Island>`). */
export function useIslandLinked(): boolean {
  const { front } = useWorkbenchView();
  const { primary } = pickLive(useIslandLive());
  return islandLinked(front.id, primary);
}

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

const CTX_AGENT = 'scene.ctxAgent';
/** The agent keeps this much height, as before the divider could be moved. */
const AGENT_MIN = 180;

/**
 * The workbench above and agent below, on the `scene.ctxAgent` split. Until the person moves the
 * divider they keep the sizes they always had (styles.css, `.rp-split.auto`): the selection card
 * at its own height, a tall tab 62% (Volumes 80%, a road 72%), the agent the rest. The split then
 * starts from where the divider stands, and once moved its fraction is remembered (ruling R11).
 */
function ContextAgentSplit({ context, agent }: { context: ReactNode; agent: ReactNode }) {
  const t = useT();
  const moved = useStore(splitPrefs, (s) => s.byId[CTX_AGENT] !== undefined);
  const [standing, setStanding] = useState(0.62);
  const agentRef = useRef<HTMLDivElement | null>(null);
  // where the divider stands while it follows the content, so a drag or a key starts there
  useEffect(() => {
    const el = agentRef.current;
    const split = el?.closest('.rp-split');
    if (moved || !el || !split || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const box = split.getBoundingClientRect();
      if (box.height <= 0) return;
      const at = (el.getBoundingClientRect().top - box.top) / box.height;
      setStanding(Math.round(Math.min(1, Math.max(0, at)) * 1000) / 1000 || 0.62);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    watch.observe(split);
    return () => {
      watch.disconnect();
    };
  }, [moved]);
  return (
    <ResizableSplit
      id={CTX_AGENT}
      className={moved ? 'rp-split' : 'rp-split auto'}
      orientation="vertical"
      sized="start"
      unit="fraction"
      defaultSize={standing}
      min={160}
      max="100%"
      otherMin={AGENT_MIN}
      label={t('panel.resizeAgent')}
      start={context}
      end={
        <div className="agent" ref={agentRef}>
          {agent}
        </div>
      }
    />
  );
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

/** What the front tab shows: today's context content for the fixed tabs. */
function FrontBody({ front, road }: { front: TabId; road: boolean }) {
  const issueId = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  if (front === 'volumes') return <VolumesPanel className="ctx-fill" />;
  if (front === 'changes') return <ChangesTab className="ctx-fill" />;
  if (front === 'issues') return <IssueRegister className="ctx-fill" />;
  if (front === 'selection') {
    if (road) return <RoadPanel />;
    if (issueId) return <IssueCard issueId={issueId} place="scene" className="ctx-fill" />;
    return <SelectionCard />;
  }
  // the workbenches and tool panels fill their tab in their own tasks
  return BENCHES.includes(front) ? <BenchHead bench={front} /> : null;
}

export function RightSidebar() {
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  const focusedWindow = useWorkspace((s) => s.focusedWindow);
  const stageMode = useShell((s) => s.stageMode);
  const focused = agentWindow(focusedWindow, stageMode);
  // the agent answers on the build route while the Model builder is open (C5)
  const modellerOpen = useModeller((s) => s.open);
  const road = useIsRoad();
  const { tabs, front } = useWorkbenchView();
  useFollow(front.id);
  const issues = useWorkspace((s) => s.issues.length);
  const piles = useVolumetric((s) => s.piles.length);
  const issueOpen = useWorkspace((s) => s.selection?.kind === 'issue');
  const id = front.id;
  const tall = id !== 'selection' || issueOpen || road;
  return (
    <aside
      className="right"
      id={PANEL_ID.right}
      aria-label="Context"
      aria-hidden={rightCollapsed}
      inert={rightCollapsed}
    >
      <RightHeader />
      <TabBar
        tabs={tabs}
        front={id}
        counts={{ issues, volumes: piles }}
        onShow={(tab) => {
          workbench.getState().show(tab);
        }}
        onPin={(tab, on) => {
          workbench.getState().pin(tab, on);
        }}
        onClose={(tab) => {
          workbench.getState().close(tab);
        }}
      />
      <TelecomTools />
      <ContextAgentSplit
        context={
          <>
            {!road && <RoadSetupCard />}
            <div
              className={`ctx-wrap wb-body${tall ? ' tall' : ''}${id === 'volumes' ? ' vol' : ''}`}
              role="tabpanel"
              id={`wb-panel-${id}`}
              aria-labelledby={`wb-tab-${id}`}
              data-front={id}
            >
              <FrontBody front={id} road={road} />
            </div>
          </>
        }
        agent={<AgentHost window={focused} task={modellerOpen ? 'build' : undefined} />}
      />
    </aside>
  );
}
