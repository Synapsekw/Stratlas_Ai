import { IssueRegister } from '@aio/annotate';
import {
  ariaKeys,
  formatDate,
  Icon,
  neighbourClip,
  Timeline,
  type TimelineModel,
  useT,
} from '@aio/ui';
import { useVolumetric, VolumesPanel } from '@aio/volumetric';
import { canCompare, useWorkspace, workspace } from '@aio/workspace';
import { useState } from 'react';
import { ChangesTab, useChangesTabSeq } from '../change';
import { IssueCard } from '../issueCard/IssueCard';
import { useCardFocusSeq } from '../issueCard/state';
import { PANEL_ID, PanelHandle } from '../shell/PanelHandle';
import { AgentHost } from '../agent/AgentHost';
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
  const project = useWorkspace((s) => s.project);
  const timeline = useTimelineShown(project);
  const dateIndex = useTimeline((s) => s.index);
  const lanes = !road && project !== null && usesLanes(project.manifest, dateIndex);
  if (!hasProject) return <NoProject view="Scene" />;

  return (
    <section
      className={`screen ws${rightCollapsed ? ' right-off' : ''}${road ? ' road' : ''}${volumes ? ' ws-vol' : ''}`}
      aria-label="Scene"
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
        {road ? (
          <RoadPanel />
        ) : (
          <>
            <RoadSetupCard />
            <ContextPanel />
          </>
        )}
        <div className="agent">
          <AgentHost window={focused} task={modellerOpen ? 'build' : undefined} />
        </div>
      </aside>
    </section>
  );
}
