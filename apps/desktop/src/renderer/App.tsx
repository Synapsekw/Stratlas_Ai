import { AnnotateStyles, issueSaver } from '@aio/annotate';
import { buildTimelineModel } from '@aio/ui';
import { getPlayer } from '@aio/video';
import { volumetric, VolumetricStyles } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { useEffect } from 'react';
import { getMedia } from './media';
import { nextClipInFlight, startPlaybackLoop } from './playback';
import { IssuesScreen } from './screens/Issues';
import { JobsScreen } from './screens/Jobs';
import { MediaScreen } from './screens/Media';
import { DetectionsScreen } from './screens/Detections';
import { ProjectsScreen } from './screens/Projects';
import { ReportsScreen } from './screens/Reports';
import { ReviewScreen } from './screens/Review';
import { SettingsScreen } from './screens/Settings';
import { WelcomeScreen } from './screens/Welcome';
import { initAuthor } from './author';
import { roadStore, startRoadSync } from './road/store';
import { Toasts } from './exports/Toasts';
import { spaceIsPlayPause } from './keys';
import {
  finishedIssuesJob,
  finishedManifestJob,
  finishedProjectJob,
  mergeDiskIssues,
} from './jobs';
import { bridge, jobs, shell, useShell } from './shell';
import { PackageExportDialog } from './shell/PackageExport';
import { Palette } from './shell/Palette';
import { UnlockDialog } from './shell/UnlockDialog';
import { Sidebar } from './shell/Sidebar';
import { TitleBar } from './shell/TitleBar';
import { applyAppearance } from './theme';
import { WorkspaceScreen } from './workspace/WorkspaceScreen';
import { BuilderLayer } from './builder/BuilderLayer';
import { Lightbox } from './issueCard/Lightbox';
import { CrashNotice } from './diagnostics/CrashNotice';
import { ReportProblemDialog } from './diagnostics/ReportProblem';
import { evidence, openEvidence, startEvidenceSplit } from './issueCard/evidence';
import { startCardFocus } from './issueCard/state';

function onKeyDown(e: KeyboardEvent) {
  const s = shell.getState();
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'k') {
    e.preventDefault();
    s.setPalette(!s.paletteOpen);
  } else if (mod && e.altKey && key === 'b') {
    e.preventDefault();
    s.toggleRight();
  } else if (mod && key === 'b') {
    e.preventDefault();
    void s.toggleSidebar();
  } else if (key === ' ' && !mod && s.screen === 'scene' && spaceIsPlayPause(e.target)) {
    const ws = workspace.getState();
    if (!ws.project) return;
    e.preventDefault();
    if (ws.playing) ws.pause();
    else ws.play();
  }
}

/** End of the active clip, so playback stops there. */
function activeClipEnd(): number | undefined {
  const ws = workspace.getState();
  const layer = ws.project?.manifest.layers.find((l) => l.id === ws.activeClip);
  const d = layer ? getMedia().durations[layer.id] : undefined;
  if (layer?.kind !== 'video' || d === undefined) return undefined;
  return layer.flight.startUtcMs + layer.offsetMs + d;
}

/** The active clip's video writes the clock while it has footage at the playhead (see playback.ts). */
function videoDrivesClock(): boolean {
  const id = workspace.getState().activeClip;
  const player = id ? getPlayer(id) : undefined;
  return player !== undefined && player.status !== 'error' && player.status !== 'no-footage';
}

/**
 * When the active clip plays to its end and the next clip of the same flight follows on, carry
 * on with it (a flight is delivered as many short clips). Returns an unsubscribe function.
 */
function continueAcrossClips(): () => void {
  return workspace.subscribe((s, prev) => {
    if (!prev.playing || s.playing || !s.project || !s.activeClip) return;
    if (s.activeClip !== prev.activeClip) return;
    const clips = buildTimelineModel(s.project.manifest, [], getMedia().durations).clips;
    const next = nextClipInFlight(clips, s.activeClip, s.nowMs);
    if (!next) return;
    const ended = s.activeClip;
    // The player pauses and then sets the end time; continue after that settles.
    queueMicrotask(() => {
      const ws = workspace.getState();
      if (ws.playing || ws.activeClip !== ended) return;
      if (ws.selection?.kind === 'clip' && ws.selection.id === ended)
        ws.select({ kind: 'clip', id: next.layerId, layer: next.layerId });
      ws.setActiveClip(next.layerId);
      ws.setTime(next.startMs);
      ws.play();
    });
  });
}

/**
 * A `.aio` the app was started with (double-click), and any handed over later by a second
 * launch, opens in this window. Returns an unsubscribe function.
 */
function openPackagesHandedOver(): () => void {
  void bridge.call('app:takeOpenPath', {}).then((r) => {
    if (r.ok && r.value.path) void shell.getState().openProject(r.value.path);
  });
  return window.aio.on('app:openPath', ({ path }) => {
    void shell.getState().openProject(path);
  });
}

function Screen() {
  const screen = useShell((s) => s.screen);
  switch (screen) {
    case 'projects':
      return <ProjectsScreen />;
    case 'welcome':
      return <WelcomeScreen />;
    case 'scene':
      return <WorkspaceScreen />;
    case 'review':
      return <ReviewScreen />;
    case 'issues':
      return <IssuesScreen />;
    case 'media':
      return <MediaScreen />;
    case 'detections':
      return <DetectionsScreen />;
    case 'reports':
      return <ReportsScreen />;
    case 'jobs':
      return <JobsScreen />;
    case 'settings':
      return <SettingsScreen />;
  }
}

export function App() {
  const collapsed = useShell((s) => s.settings.sidebarCollapsed);
  const theme = useShell((s) => s.settings.theme);
  const direction = useShell((s) => s.settings.direction);
  const screen = useShell((s) => s.screen);

  useEffect(() => {
    void shell.getState().init();
    void jobs.getState().init();
    // a finished conversion (point cloud to COPC) adds a layer: reload the open manifest
    const stopJobReload = jobs.subscribe((s, prev) => {
      const project = workspace.getState().project;
      if (!project || !finishedManifestJob(prev.jobs, s.jobs, project.root)) return;
      // the road builder also rewrites issues.json and road.json: reopen the project whole
      const whole = finishedProjectJob(prev.jobs, s.jobs, project.root);
      void bridge.call('project:open', { path: project.root }).then((r) => {
        const ws = workspace.getState();
        if (!r.ok || !r.value.ok || ws.project?.id !== project.id) return;
        if (whole) ws.openProject({ ...project, manifest: r.value.manifest }, r.value.issues);
        else ws.replaceManifest(r.value.manifest);
      });
    });
    // the inspection pipeline merged issues.json on disk: take its issues, keep unsaved edits
    const stopIssueReload = jobs.subscribe((s, prev) => {
      const project = workspace.getState().project;
      if (!project || !finishedIssuesJob(prev.jobs, s.jobs, project.root)) return;
      void bridge.call('project:open', { path: project.root }).then((r) => {
        const ws = workspace.getState();
        if (!r.ok || !r.value.ok || ws.project?.id !== project.id) return;
        const merged = mergeDiskIssues(ws.issues, r.value.issues);
        workspace.setState({ issues: merged.issues });
        if (merged.unsaved) issueSaver.schedule(project.id, merged.issues);
      });
    });
    void initAuthor(bridge);
    window.addEventListener('keydown', onKeyDown);
    const stopPlayback = startPlaybackLoop(
      workspace,
      activeClipEnd,
      requestAnimationFrame,
      cancelAnimationFrame,
      videoDrivesClock,
    );
    const stopContinue = continueAcrossClips();
    // a picked issue opens its card: the right panel unfolds if it was folded away
    const stopCard = startCardFocus(workspace, ({ id, fromScene }) => {
      const sh = shell.getState();
      if (sh.rightCollapsed) sh.toggleRight();
      // picked in 3D: its photo (or video frame) opens beside the 3D view; an open evidence
      // pane follows the card to the next issue
      const ev = evidence.getState();
      if (sh.screen === 'scene' && ((fromScene && ev.enabled) || ev.open)) openEvidence(id);
    });
    const stopEvidence = startEvidenceSplit();
    const stopOpenPath = openPackagesHandedOver();
    const stopRoad = startRoadSync();
    // A road survey opens map first.
    const stopRoadMode = roadStore.subscribe((s, prev) => {
      if (s.status === 'ready' && prev.status !== 'ready') shell.getState().setStageMode('map');
    });
    // a volumetric project opens its volumes (volumes.json beside the manifest)
    const stopVolumes = workspace.subscribe((s, prev) => {
      if (s.project !== prev.project) void volumetric.getState().load();
    });
    return () => {
      stopOpenPath();
      stopJobReload();
      stopIssueReload();
      stopRoad();
      stopRoadMode();
      window.removeEventListener('keydown', onKeyDown);
      stopPlayback();
      stopContinue();
      stopCard();
      stopEvidence();
      stopVolumes();
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      applyAppearance(document.documentElement, { theme, direction }, media.matches);
    };
    apply();
    media.addEventListener('change', apply);
    return () => {
      media.removeEventListener('change', apply);
    };
  }, [theme, direction]);

  return (
    <div className="app" data-sb={collapsed ? 'collapsed' : 'expanded'} data-screen={screen}>
      <AnnotateStyles />
      <VolumetricStyles />
      <TitleBar />
      <Sidebar />
      <main className="main">
        <Screen />
      </main>
      <Palette />
      <UnlockDialog />
      <PackageExportDialog />
      <Toasts />
      <BuilderLayer />
      <Lightbox />
      <ReportProblemDialog />
      <CrashNotice />
    </div>
  );
}
