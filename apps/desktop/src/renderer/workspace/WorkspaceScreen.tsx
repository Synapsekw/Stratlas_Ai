import { AgentPanel } from '@aio/ai';
import { IssueDetail, IssueRegister } from '@aio/annotate';
import { buildTimelineModel, formatDate, neighbourClip, Timeline } from '@aio/ui';
import { useVolumetric, VolumesPanel } from '@aio/volumetric';
import { useWorkspace, workspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { useMedia } from '../media';
import { selectClip } from '../shell/Sidebar';
import { useShell } from '../shell';
import { NoProject } from '../screens/NoProject';
import { SelectionCard } from './SelectionCard';
import { Stage } from './Stage';

function WorkspaceTimeline() {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const nowMs = useWorkspace((s) => s.nowMs);
  const playing = useWorkspace((s) => s.playing);
  const rate = useWorkspace((s) => s.rate);
  const activeClip = useWorkspace((s) => s.activeClip);
  const selection = useWorkspace((s) => s.selection);
  const { durations } = useMedia(project);
  const model = useMemo(
    () =>
      project
        ? buildTimelineModel(project.manifest, issues, durations)
        : { clips: [], groups: [], issues: [], photos: [], captures: [], range: null },
    [project, issues, durations],
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
      onSeek={(t) => {
        workspace.getState().setTime(t);
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
        // A clip bar plays its clip: from the clicked time on a flight bar, else from the
        // playhead when it is inside the clip, else from the clip start.
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

/** Top of the right panel: the selection (issue detail for an issue) or the issue register. */
function ContextPanel() {
  const [chosen, setTab] = useState<'selection' | 'issues' | 'volumes' | null>(null);
  const issueId = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  const count = useWorkspace((s) => s.issues.length);
  const volumes = useVolumetric((s) => s.status !== 'none' && s.status !== 'idle');
  const piles = useVolumetric((s) => s.piles.length);
  // volumetric projects open on their volumes
  const tab =
    chosen === 'volumes' && !volumes
      ? 'selection'
      : (chosen ?? (volumes ? 'volumes' : 'selection'));
  const tall = tab === 'issues' || tab === 'volumes' || issueId !== null;
  return (
    <div className={`ctx-wrap${tall ? ' tall' : ''}${tab === 'volumes' ? ' vol' : ''}`}>
      <div className="seg ctx-tabs" role="tablist" aria-label="Context">
        {volumes && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'volumes'}
            aria-pressed={tab === 'volumes'}
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
          aria-pressed={tab === 'selection'}
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
          aria-pressed={tab === 'issues'}
          onClick={() => {
            setTab('issues');
          }}
        >
          Issues <span className="mono faint">{count}</span>
        </button>
      </div>
      {tab === 'volumes' ? (
        <VolumesPanel className="ctx-fill" />
      ) : tab === 'issues' ? (
        <IssueRegister className="ctx-fill" />
      ) : issueId ? (
        <IssueDetail issueId={issueId} className="ctx-fill" />
      ) : (
        <SelectionCard />
      )}
    </div>
  );
}

export function WorkspaceScreen() {
  const hasProject = useWorkspace((s) => s.project !== null);
  const focused = useWorkspace((s) => s.focusedWindow);
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  const volumes = useVolumetric((s) => s.status === 'ready');
  if (!hasProject) return <NoProject view="Scene" />;

  return (
    <section
      className={`screen ws${rightCollapsed ? ' right-off' : ''}${volumes ? ' ws-vol' : ''}`}
      aria-label="Scene"
    >
      <Stage />
      <div className="tl-wrap">
        <WorkspaceTimeline />
      </div>
      <aside
        className="right"
        aria-label="Context"
        aria-hidden={rightCollapsed}
        inert={rightCollapsed}
      >
        <ContextPanel />
        <div className="agent">
          <AgentPanel window={focused ?? 'scene3d'} className="agent-host" />
        </div>
      </aside>
    </section>
  );
}
