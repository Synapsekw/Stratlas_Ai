import { AgentPanel } from '@aio/ai';
import { IssueRegister } from '@aio/annotate';
import {
  ariaKeys,
  buildTimelineModel,
  formatDate,
  Icon,
  neighbourClip,
  Timeline,
  useT,
} from '@aio/ui';
import { useVolumetric, VolumesPanel } from '@aio/volumetric';
import { canCompare, useWorkspace, workspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { ChangesTab, useChangesTabSeq } from '../change';
import { jumpToKeyframe, moveKeyframe, timelineKeys } from '../builder/alignSession';
import { IssueCard } from '../issueCard/IssueCard';
import { useCardFocusSeq } from '../issueCard/state';
import { useMedia } from '../media';
import { selectClip } from '../shell/Sidebar';
import { cloudAiBlocked } from '../player';
import { useModeller } from '../modeller';
import { useShell } from '../shell';
import { ChainageRuler } from '../road/ChainageRuler';
import { RoadPanel } from '../road/RoadPanel';
import { RoadSetupCard } from '../road/RoadSetup';
import { useIsRoad } from '../road/useRoadMap';
import { NoProject } from '../screens/NoProject';
import { AgentFixCard } from './AgentFixCard';
import { useCaptureIndex } from './compare';
import { agentWindow } from './agentWindow';
import { DateBar } from './DateBar';
import { LayerPlaceholder } from './LayerPlaceholder';
import { SelectionCard } from './SelectionCard';
import { Stage } from './Stage';
import { toggleTimeline, useTimelineShown } from './timelinePref';

function WorkspaceTimeline() {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const nowMs = useWorkspace((s) => s.nowMs);
  const playing = useWorkspace((s) => s.playing);
  const rate = useWorkspace((s) => s.rate);
  const activeClip = useWorkspace((s) => s.activeClip);
  const selection = useWorkspace((s) => s.selection);
  const directionDraft = useWorkspace((s) => s.directionDraft);
  const orientation = useWorkspace((s) => s.orientation);
  const { durations } = useMedia(project);
  const model = useMemo(
    () =>
      project
        ? buildTimelineModel(
            project.manifest,
            issues,
            durations,
            timelineKeys(orientation, directionDraft),
          )
        : { clips: [], groups: [], issues: [], photos: [], captures: [], range: null },
    [project, issues, durations, orientation, directionDraft],
  );
  const capture = project?.manifest.captures.at(-1);

  return (
    <Timeline
      className="ws-tl"
      model={model}
      nowMs={nowMs}
      playing={playing}
      rate={rate}
      activeClip={activeClip}
      selectedIssue={selection?.kind === 'issue' ? selection.id : null}
      context={`${capture ? `${formatDate(capture.date)} · ` : ''}UTC`}
      hideKeys="T"
      onHide={() => {
        toggleTimeline(workspace.getState().project);
      }}
      onSeek={(t) => {
        workspace.getState().setTime(t);
      }}
      onKeyframe={(layerId, index) => {
        jumpToKeyframe(layerId, index);
      }}
      onKeyframeMove={(layerId, index, tMs, phase) => {
        moveKeyframe(layerId, index, tMs, phase);
      }}
      onTogglePlay={() => {
        const ws = workspace.getState();
        if (ws.playing) ws.pause();
        else ws.play();
      }}
      onRate={(r) => {
        workspace.getState().setRate(r);
      }}
      onClip={(id, atMs) => {
        // A clip bar plays its clip: from the clicked time, else (keyboard) from the playhead
        // when it is inside the clip, else from the clip start.
        selectClip(id);
        const ws = workspace.getState();
        const clip = model.clips.find((c) => c.layerId === id);
        if (atMs !== undefined) ws.setTime(atMs);
        else if (clip && (ws.nowMs < clip.startMs || ws.nowMs >= clip.endMs - 250))
          ws.setTime(clip.startMs);
        ws.play();
      }}
      onIssue={(id) => {
        workspace.getState().select({ kind: 'issue', id });
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
  const pkg = useShell((s) => s.pkg);
  // the agent answers on the build route while the Model builder is open (C5)
  const modellerOpen = useModeller((s) => s.open);
  // the agent checks its route again when the AI settings change
  const aiKey = useShell((s) =>
    JSON.stringify([
      s.settings.cloudAi,
      s.settings.offlineOnly === true,
      s.settings.routes,
      s.settings.localModel,
    ]),
  );
  const road = useIsRoad();
  const volumes = useVolumetric((s) => s.status === 'ready');
  const project = useWorkspace((s) => s.project);
  const timeline = useTimelineShown(project);
  if (!hasProject) return <NoProject view="Scene" />;

  return (
    <section
      className={`screen ws${rightCollapsed ? ' right-off' : ''}${road ? ' road' : ''}${volumes ? ' ws-vol' : ''}`}
      aria-label="Scene"
    >
      <h1 className="sr-only">{t('nav.scene')}</h1>
      <DateBar />
      <Stage />
      <LayerPlaceholder />
      <div className="tl-wrap">
        {road ? <ChainageRuler /> : timeline ? <WorkspaceTimeline /> : <TimelineBar />}
      </div>
      <aside
        className="right"
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
          {cloudAiBlocked(pkg) ? (
            <p className="faint small" style={{ padding: 12 }} data-testid="agent-blocked">
              This package does not allow cloud AI. Nothing from it is sent to any provider.
            </p>
          ) : (
            <AgentPanel
              window={focused}
              task={modellerOpen ? 'build' : undefined}
              settingsKey={aiKey}
              className="agent-host"
              renderFix={(controls) => <AgentFixCard {...controls} />}
            />
          )}
        </div>
      </aside>
    </section>
  );
}
