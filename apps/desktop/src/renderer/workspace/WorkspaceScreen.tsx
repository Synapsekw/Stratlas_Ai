import { AgentPanel } from '@aio/ai';
import { buildTimelineModel, formatDate, neighbourClip, Timeline } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useMemo } from 'react';
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
        : { clips: [], issues: [], photos: [], captures: [], range: null },
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
      onClip={(id) => {
        selectClip(id);
        const clip = model.clips.find((c) => c.layerId === id);
        const now = workspace.getState().nowMs;
        if (clip && (now < clip.startMs || now > clip.endMs))
          workspace.getState().setTime(clip.startMs);
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

export function WorkspaceScreen() {
  const hasProject = useWorkspace((s) => s.project !== null);
  const focused = useWorkspace((s) => s.focusedWindow);
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  if (!hasProject) return <NoProject view="Scene" />;

  return (
    <section className={`screen ws${rightCollapsed ? ' right-off' : ''}`} aria-label="Scene">
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
        <SelectionCard />
        <div className="agent">
          <AgentPanel window={focused ?? 'scene3d'} className="agent-host" />
        </div>
      </aside>
    </section>
  );
}
