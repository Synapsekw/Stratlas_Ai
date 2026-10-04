import { AnnotateStyles } from '@aio/annotate';
import { buildTimelineModel } from '@aio/ui';
import { getPlayer } from '@aio/video';
import { workspace } from '@aio/workspace';
import { useEffect } from 'react';
import { getMedia } from './media';
import { nextClipInFlight, startPlaybackLoop } from './playback';
import { IssuesScreen } from './screens/Issues';
import { MediaScreen } from './screens/Media';
import { ProjectsScreen } from './screens/Projects';
import { ReportsScreen } from './screens/Reports';
import { ReviewScreen } from './screens/Review';
import { SettingsScreen } from './screens/Settings';
import { initAuthor } from './author';
import { spaceIsPlayPause } from './keys';
import { bridge, shell, useShell } from './shell';
import { Palette } from './shell/Palette';
import { Sidebar } from './shell/Sidebar';
import { TitleBar } from './shell/TitleBar';
import { WorkspaceScreen } from './workspace/WorkspaceScreen';

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

function Screen() {
  const screen = useShell((s) => s.screen);
  switch (screen) {
    case 'projects':
      return <ProjectsScreen />;
    case 'scene':
      return <WorkspaceScreen />;
    case 'review':
      return <ReviewScreen />;
    case 'issues':
      return <IssuesScreen />;
    case 'media':
      return <MediaScreen />;
    case 'reports':
      return <ReportsScreen />;
    case 'settings':
      return <SettingsScreen />;
  }
}

export function App() {
  const collapsed = useShell((s) => s.settings.sidebarCollapsed);
  const theme = useShell((s) => s.settings.theme);
  const screen = useShell((s) => s.screen);

  useEffect(() => {
    void shell.getState().init();
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
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      stopPlayback();
      stopContinue();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="app" data-sb={collapsed ? 'collapsed' : 'expanded'} data-screen={screen}>
      <AnnotateStyles />
      <TitleBar />
      <Sidebar />
      <main className="main">
        <Screen />
      </main>
      <Palette />
    </div>
  );
}
