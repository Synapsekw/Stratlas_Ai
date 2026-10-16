import { IssueRegister } from '@aio/annotate';
import { TelecomTools } from '../survey/TelecomTools';
import {
  ariaKeys,
  formatDate,
  Icon,
  neighbourClip,
  ResizableSplit,
  splitPrefs,
  Timeline,
  type TimelineModel,
  useResizableSplit,
  useT,
} from '@aio/ui';
import { useVolumetric, VolumesPanel } from '@aio/volumetric';
import { canCompare, useWorkspace, workspace } from '@aio/workspace';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type ReactNode,
  type TransitionEvent,
} from 'react';
import { useStore } from 'zustand';
import { ChangesTab, useChangesTabSeq } from '../change';
import { IssueCard } from '../issueCard/IssueCard';
import { useCardFocusSeq } from '../issueCard/state';
import { PANEL_ID, PanelHandle } from '../shell/PanelHandle';
import { useFold } from '../shell/useFold';
import { AgentHost } from '../agent/AgentHost';
import { RightHeader } from '../shell/RightHeader';
import { useModeller } from '../modeller';
import { shell, useShell } from '../shell';
import { ChainageRuler } from '../road/ChainageRuler';
import { RoadPanel } from '../road/RoadPanel';
import { RoadSetupCard } from '../road/RoadSetup';
import { useIsRoad } from '../road/useRoadMap';
import { NoProject } from '../screens/NoProject';
import { useCaptureIndex } from './compare';
import { agentWindow } from './agentWindow';
import { DateBar } from './DateBar';
import { DateRow } from './DateRow';
import { usesLanes } from './lanes';
import { LayerPlaceholder } from './LayerPlaceholder';
import { pickClip, selectClip } from './pickClip';
import { SelectionCard } from './SelectionCard';
import { Stage } from './Stage';
import { useTimeline } from './timeline';
import { timelineActions, useTimelineBinding } from './timelineBinding';
import { toggleTimeline, useTimelineShown } from './timelinePref';
import { LaneFocusFollow, WorkspaceLanes } from './WorkspaceLanes';

const EMPTY_MODEL: TimelineModel = {
  clips: [],
  groups: [],
  issues: [],
  photos: [],
  captures: [],
  range: null,
};

function WorkspaceTimeline() {
  const {
    project,
    nowMs,
    playing,
    rate,
    activeClip,
    selectedIssue,
    model: built,
  } = useTimelineBinding();
  const model = built ?? EMPTY_MODEL;
  const capture = project?.manifest.captures.at(-1);

  return (
    <Timeline
      {...timelineActions}
      className="ws-tl"
      model={model}
      nowMs={nowMs}
      playing={playing}
      rate={rate}
      activeClip={activeClip}
      selectedIssue={selectedIssue}
      context={`${capture ? `${formatDate(capture.date)} · ` : ''}UTC`}
      hideKeys="T"
      onClip={(id, atMs) => {
        // A clip bar selects its clip and seeks; Space or Play plays.
        pickClip(
          id,
          atMs,
          model.clips.find((c) => c.layerId === id),
        );
      }}
      onStep={(dir) => {
        const c = neighbourClip(model, workspace.getState().activeClip, dir);
        if (!c) return;
        selectClip(c.layerId);
        workspace.getState().setTime(c.startMs);
      }}
    />
  );
}

/**
 * The timeline folded away (projects without video start like this): a thin bar that brings it
 * back, saying why it is folded.
 */
function TimelineBar() {
  const t = useT();
  const clips = useWorkspace(
    (s) => s.project?.manifest.layers.filter((l) => l.kind === 'video').length ?? 0,
  );
  return (
    <div className="tl-bar" data-testid="timeline-bar">
      <button
        type="button"
        className="tl-bar-btn"
        aria-label={t('timeline.show')}
        aria-keyshortcuts={ariaKeys('scene.timeline')}
        title={`${t('timeline.show')} (T)`}
        onClick={() => {
          toggleTimeline(workspace.getState().project);
        }}
      >
        <Icon name="clock" size={14} />
        {t('timeline.title')}
        <Icon name="chevup" size={14} />
      </button>
      <span className="tl-bar-note">
        {clips > 0 ? t('timeline.clips', { count: clips }) : t('timeline.noVideo')}
      </span>
    </div>
  );
}

/** Top of the right panel: the selection (issue detail for an issue) or the issue register. */
function ContextPanel() {
  const [chosen, setTab] = useState<'selection' | 'issues' | 'volumes' | 'changes' | null>(null);
  const issueId = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  const count = useWorkspace((s) => s.issues.length);
  const volumes = useVolumetric((s) => s.status !== 'none' && s.status !== 'idle');
  const piles = useVolumetric((s) => s.piles.length);
  // a newly picked issue (pin, marker, timeline mark, register row) opens its card
  const focusSeq = useCardFocusSeq();
  const [seenSeq, setSeenSeq] = useState(focusSeq);
  if (seenSeq !== focusSeq) {
    setSeenSeq(focusSeq);
    setTab('selection');
  }
  // M8 C1: two survey dates offer the Changes tab; Show changes brings it to the front
  const captureIx = useCaptureIndex();
  const dated = captureIx !== null && canCompare(captureIx);
  const changesSeq = useChangesTabSeq();
  const [seenChanges, setSeenChanges] = useState(changesSeq);
  if (seenChanges !== changesSeq) {
    setSeenChanges(changesSeq);
    setTab('changes');
  }
  // volumetric projects open on their volumes
  const tab =
    (chosen === 'volumes' && !volumes) || (chosen === 'changes' && !dated)
      ? 'selection'
      : (chosen ?? (volumes ? 'volumes' : 'selection'));
  const tall = tab === 'issues' || tab === 'volumes' || tab === 'changes' || issueId !== null;
  return (
    <div className={`ctx-wrap${tall ? ' tall' : ''}${tab === 'volumes' ? ' vol' : ''}`}>
      <div className="seg ctx-tabs" role="tablist" aria-label="Context">
        {volumes && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'volumes'}
            onClick={() => {
              setTab('volumes');
            }}
          >
            Volumes <span className="mono faint">{piles}</span>
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'selection'}
          onClick={() => {
            setTab('selection');
          }}
        >
          Selection
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'issues'}
          onClick={() => {
            setTab('issues');
          }}
        >
          Issues <span className="mono faint">{count}</span>
        </button>
        {dated && (
          <button
            type="button"
            role="tab"
            data-testid="tab-changes"
            aria-selected={tab === 'changes'}
            onClick={() => {
              setTab('changes');
            }}
          >
            Changes
          </button>
        )}
      </div>
      {tab === 'volumes' ? (
        <VolumesPanel className="ctx-fill" />
      ) : tab === 'changes' ? (
        <ChangesTab className="ctx-fill" />
      ) : tab === 'issues' ? (
        <IssueRegister className="ctx-fill" />
      ) : issueId ? (
        <IssueCard issueId={issueId} place="scene" className="ctx-fill" />
      ) : (
        <SelectionCard />
      )}
    </div>
  );
}

/**
 * The stage and the right panel on the `scene.right` split: the panel's width is the grid's
 * second column, dragged on its inner edge and remembered; folded (Ctrl+Alt+B, the tab, or a
 * drag), it is the 12 px strip. The panel slides with a transform and the grid snaps once, so
 * the 3D view and the map are resized once (shell/useFold.ts).
 */
/** The strip the right panel folds to: its border and the 12 px tab (`--ph-w`), as before. */
const RIGHT_STRIP = 13;

function useRightSplit(collapsed: boolean, volumes: boolean, hasProject: boolean) {
  const fold = useFold(collapsed);
  const { snap } = fold;
  const split = useResizableSplit({
    id: 'scene.right',
    orientation: 'horizontal',
    sized: 'end',
    unit: 'px',
    // volumetric projects: a wider panel for the pile register
    defaultSize: volumes ? 400 : 360,
    min: 280,
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
 * The right panel's context above and agent below, on the `scene.ctxAgent` split. Until the
 * person moves the divider they keep the sizes they always had (styles.css, `.rp-split.auto`):
 * the selection card at its own height, a tall tab 62% (Volumes 80%, a road 72%), the agent the
 * rest. The split then starts from where the divider stands, and once moved its fraction is
 * remembered (ruling R11).
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

export function WorkspaceScreen() {
  const t = useT();
  const hasProject = useWorkspace((s) => s.project !== null);
  const focusedWindow = useWorkspace((s) => s.focusedWindow);
  const stageMode = useShell((s) => s.stageMode);
  const focused = agentWindow(focusedWindow, stageMode);
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  // the agent answers on the build route while the Model builder is open (C5)
  const modellerOpen = useModeller((s) => s.open);
  const road = useIsRoad();
  const volumes = useVolumetric((s) => s.status === 'ready');
  const right = useRightSplit(rightCollapsed, volumes, hasProject);
  const { containerRef: rightSplitRef, separatorProps: rightResize } = right;
  const project = useWorkspace((s) => s.project);
  const timeline = useTimelineShown(project);
  const dateIndex = useTimeline((s) => s.index);
  const lanes = !road && project !== null && usesLanes(project.manifest, dateIndex);
  if (!hasProject) return <NoProject view="Scene" />;

  return (
    <section
      ref={rightSplitRef}
      className={`screen ws${rightCollapsed ? ' right-off' : ''}${road ? ' road' : ''}${volumes ? ' ws-vol' : ''}`}
      aria-label="Scene"
      data-fold={right.phase ?? undefined}
      onTransitionEnd={right.onTransitionEnd}
      onAnimationEnd={right.onAnimationEnd}
    >
      <h1 className="sr-only">{t('nav.scene')}</h1>
      {!lanes && <DateBar />}
      {lanes && <LaneFocusFollow />}
      <Stage />
      <LayerPlaceholder />
      <div className="tl-wrap">
        {road ? (
          <ChainageRuler />
        ) : lanes ? (
          timeline ? (
            <WorkspaceLanes />
          ) : (
            <DateRow />
          )
        ) : timeline ? (
          <WorkspaceTimeline />
        ) : (
          <TimelineBar />
        )}
      </div>
      <div
        {...rightResize}
        className="split-handle rp-resize"
        aria-label={t('panel.resizeRight')}
        aria-controls={PANEL_ID.right}
      >
        <span className="kbd split-readout" aria-hidden="true" />
      </div>
      <PanelHandle
        side="right"
        collapsed={rightCollapsed}
        shortcut="global.rightPanel"
        onToggle={shell.getState().toggleRight}
      />
      <aside
        className="right"
        id={PANEL_ID.right}
        aria-label="Context"
        aria-hidden={rightCollapsed}
        inert={rightCollapsed}
      >
        <RightHeader />
        <TelecomTools />
        <ContextAgentSplit
          context={
            road ? (
              <RoadPanel />
            ) : (
              <>
                <RoadSetupCard />
                <ContextPanel />
              </>
            )
          }
          agent={<AgentHost window={focused} task={modellerOpen ? 'build' : undefined} />}
        />
      </aside>
    </section>
  );
}
