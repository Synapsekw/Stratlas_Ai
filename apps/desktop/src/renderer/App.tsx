import {
  AnnotateStyles,
  issueSaver,
  registerClassCreator,
  registerSeverityCreator,
  setAnnotationPeople,
  setPhotoRotator,
} from '@aio/annotate';
import { changeStore } from '@aio/change';
import {
  announce,
  buildTimelineModel,
  keepFocusAlive,
  LiveAnnouncer,
  matchShortcut,
  t,
  useResizableSplit,
} from '@aio/ui';
import { getPlayer } from '@aio/video';
import { volumetric, VolumetricStyles } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  type CSSProperties,
  type TransitionEvent,
} from 'react';
import { getMedia } from './media';
import { nextClipInFlight, startPlaybackLoop } from './playback';
import { IssuesScreen } from './screens/Issues';
import { jobTitle } from './processing/pipelines';
import { PipelineDialog } from './processing/PipelineDialog';
import { ProcessingDrawer } from './processing/ProcessingDrawer';
import { startFarWatch } from './builder/farSession';
import { startLineUpSession } from './lineup/lineUpStart';
import { MediaScreen } from './screens/Media';
import { DetectionsScreen } from './screens/Detections';
import { ProjectsScreen } from './screens/Projects';
import { ReportsScreen } from './screens/Reports';
import { SettingsScreen } from './screens/Settings';
import { WelcomeScreen } from './screens/Welcome';
import { initAuthor } from './author';
import { ClassNotice } from './classes/ClassNotice';
import { createClass, createSeverityModel } from './classes/store';
import { detections, loadDetections } from './detections/store';
import { roadStore, startRoadSync } from './road/store';
import { Toasts } from './exports/Toasts';
import { LineUpDialog } from './lineup/LineUpDialog';
import { isTypingTarget, spaceIsPlayPause } from './keys';
import {
  finishedChangeJob,
  finishedIssuesJob,
  finishedManifestJob,
  finishedProjectJob,
  watchJobEnds,
  mergeDiskIssues,
  sameFolder,
} from './jobs';
import { compareStore, engineClient } from './survey/compareStore';
import { convertAfterJob } from './survey/measureStore';
import { bridge, jobs, shell, useShell } from './shell';
import { installLastView } from './library/lastView';
import { PanoImportDialog } from './panos/PanoImportDialog';
import { PackageExportDialog } from './shell/PackageExport';
import { Palette } from './shell/Palette';
import { UnlockDialog } from './shell/UnlockDialog';
import { Sidebar } from './shell/Sidebar';
import { useFold } from './shell/useFold';
import { isSidebarFolded } from './store';
import { openAgent } from './shell/RightHeader';
import { captionVars, railWidth, rendererPlatform } from './shell/caption';
import { SyncHost } from './team/SyncStatus';
import { applyAppearance, OS_QUERIES } from './theme';
import { HelpPanel } from './help/HelpPanel';
import { help } from './help/store';
import { timeline, useTimelineSync } from './workspace/timeline';
import { connectVolumeDates } from './workspace/volumeDates';
import { connectVolumeChange } from './workspace/VolumeTools';
import { WorkspaceScreen } from './workspace/WorkspaceScreen';
import { BuilderLayer } from './builder/BuilderLayer';
import { DrawingsLayer } from './drawings/DrawingsLayer';
import { ModellerLayer } from './modeller/ModellerLayer';
import { EngineerLayer } from './engineer/EngineerLayer';
// RF coverage (rf-coverage T10): the Coverage layer on the map and in the 3D view
import { RfLayer } from './rf/RfLayer';
import { Lightbox } from './issueCard/Lightbox';
import { LayerProperties } from './shell/LayerProperties';
import { RemoveHost } from './shell/RemoveHost';
import { AreaCompareHost } from './change/area/AreaCompareDialog';
import { SpotViewer } from './workspace/spot/SpotViewer';
import { CrashNotice } from './diagnostics/CrashNotice';
import { ReportProblemDialog } from './diagnostics/ReportProblem';
import { saveDiagnostics } from './diagnostics/state';
import { collabStore, loadCollab } from '@aio/collab/ui';
import { followJournalChanges } from './team/reload';
import { teamUi } from './team/store';
import { toasts } from './exports/exports';
import { evidence, openEvidence, startEvidenceSplit } from './issueCard/evidence';
import { registerAppChangeProducers } from './change/producers/register';
import { startCardFocus } from './issueCard/state';
import { AgentDock, useAgentDockOpen } from './agent/AgentDock';
import { isDockScreen } from './agent/dockScreens';
import { startAgentSession } from './agent/session';
import { startAgentPaneFollow } from './agent/agentPaneStore';
import { startActivityFollow } from './workspace/workbench/activityFollow';
import { startWorkbenchReset } from './workspace/workbench/workbenchStore';

/** The Globe (M10 G6) is its own chunk: CesiumJS loads only when the Globe opens. */
const GlobeScreen = lazy(() => import('./globe/GlobeScreen'));

function onKeyDown(e: KeyboardEvent) {
  const s = shell.getState();
  const id = matchShortcut('global', e);
  if (id === 'global.help') {
    e.preventDefault();
    const h = help.getState();
    if (h.open) h.closeHelp();
    else h.openHelp();
  } else if (id === 'global.palette') {
    e.preventDefault();
    s.setPalette(!s.paletteOpen);
  } else if (id === 'global.rightPanel') {
    e.preventDefault();
    // where the agent is in its own column, the shortcut folds that column
    if (isDockScreen(s.screen) && workspace.getState().project) s.toggleAgentDock();
    else s.toggleRight();
  } else if (id === 'global.sidebar') {
    e.preventDefault();
    void s.toggleSidebar();
  } else if (id === 'global.agent') {
    // D25: open the agent where the screen has one and put the cursor in it
    e.preventDefault();
    openAgent();
  } else if (
    (id === 'global.prevSurvey' || id === 'global.nextSurvey') &&
    !e.defaultPrevented &&
    s.screen === 'scene' &&
    !isTypingTarget(e.target)
  ) {
    e.preventDefault();
    timeline.getState().step(id === 'global.prevSurvey' ? -1 : 1);
  } else if (
    id === 'global.playPause' &&
    !e.defaultPrevented &&
    s.screen === 'scene' &&
    spaceIsPlayPause(e.target)
  ) {
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
 * launch, opens in this window. A `.aiosync` exchange file opens the import dialog with its path
 * (over the open project). Returns an unsubscribe function.
 */
function openPackagesHandedOver(): () => void {
  const open = (path: string) => {
    if (path.toLowerCase().endsWith('.aiosync')) teamUi.getState().open('import', path);
    else void shell.getState().openProject(path);
  };
  void bridge.call('app:takeOpenPath', {}).then((r) => {
    if (r.ok && r.value.path) open(r.value.path);
  });
  return window.aio.on('app:openPath', ({ path }) => {
    open(path);
  });
}

/** Application menu items (macOS Settings…, Help, Search Commands…). Returns unsubscribe. */
function followMenu(): () => void {
  return window.aio.on('app:menu', ({ action }) => {
    const s = shell.getState();
    if (action === 'settings') s.go('settings');
    else if (action === 'guide') help.getState().openHelp();
    else if (action === 'exportDiagnostics') void exportDiagnosticsFromMenu();
    else s.setPalette(true);
  });
}

/** Help, Export diagnostics…: save the bundle and say where it went in a toast. */
async function exportDiagnosticsFromMenu(): Promise<void> {
  const r = await saveDiagnostics(bridge);
  if (r.ok && !r.value) return; // save dialog cancelled
  const id = `diagnostics-${String(Date.now())}`;
  toasts.getState().start(id, t('diag.export'));
  if (r.ok) toasts.getState().finish(id, 'done', r.value ?? '');
  else toasts.getState().finish(id, 'error', r.error);
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
    case 'issues':
      return <IssuesScreen />;
    case 'media':
      return <MediaScreen />;
    case 'detections':
      return <DetectionsScreen />;
    case 'reports':
      return <ReportsScreen />;
    case 'globe':
      return (
        <Suspense fallback={null}>
          <GlobeScreen />
        </Suspense>
      );
    case 'settings':
      return <SettingsScreen />;
  }
}

/**
 * No title bar: the window's own buttons sit over the app's top rows (main/index.ts), and the rows
 * under them keep clear through these (shell/caption.ts, styles.css).
 */
const PLATFORM = rendererPlatform();
const CAPTION_VARS = captionVars(PLATFORM) as CSSProperties;

/** The icon rail the sidebar folds to (tokens.css `--sb-w-c`; wider on macOS, styles.css). */
const SIDEBAR_RAIL = railWidth(PLATFORM);

/**
 * The left sidebar on the `shell.sidebar` split: its width is the `.app` grid's first column,
 * dragged on its inner edge and remembered; folded, it is the rail (52 px, 76 on macOS). The fold
 * is the person's (`sidebarCollapsed`) or the window's (shell/autoFold.ts). The panel slides out
 * with a transform and the grid snaps once at the end; opening, the grid snaps first (useFold.ts).
 */
function useSidebarSplit() {
  const folded = useShell(isSidebarFolded);
  const fold = useFold(folded);
  const { snap } = fold;
  const split = useResizableSplit({
    id: 'shell.sidebar',
    orientation: 'horizontal',
    sized: 'start',
    unit: 'px',
    defaultSize: 252,
    min: 220,
    max: 320,
    otherMin: 600,
    collapsedSize: SIDEBAR_RAIL,
    collapsed: fold.layoutFolded,
    // dragged to the rail or out of it: the panel is there already, so it does not slide
    onCollapsedChange: (next) => {
      snap(next);
      const s = shell.getState();
      if (next !== isSidebarFolded(s)) void s.toggleSidebar();
    },
  });
  // the window's width folds the sidebar on its own (shell/autoFold.ts)
  useEffect(() => {
    const follow = () => {
      shell.getState().setWindowWidth(window.innerWidth);
    };
    follow();
    window.addEventListener('resize', follow);
    return () => {
      window.removeEventListener('resize', follow);
    };
  }, []);
  const { settle, phase } = fold;
  const { containerRef } = split;
  // The tab slides as far as the edge moves: the open width less the rail, measured in px when
  // the slide starts (the column's width is a clamp with percentages, which mean the tab's own
  // box inside a transform). Opening, the grid has already snapped open here.
  useLayoutEffect(() => {
    const sidebar = containerRef.current?.querySelector(':scope > .sidebar');
    if (!containerRef.current || !sidebar || !phase) return;
    const open = sidebar.getBoundingClientRect().width;
    containerRef.current.style.setProperty(
      '--sb-fold-dx',
      `${String(Math.max(0, open - SIDEBAR_RAIL))}px`,
    );
  }, [phase, containerRef]);
  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    const el = e.target as Element;
    if (e.propertyName === 'transform' && el.classList.contains('sb-surface')) settle();
  };
  return {
    folded,
    phase,
    containerRef,
    separatorProps: split.separatorProps,
    onTransitionEnd,
  };
}

export function App() {
  const sidebar = useSidebarSplit();
  const { containerRef: sidebarSplitRef, separatorProps: sidebarResize } = sidebar;
  const theme = useShell((s) => s.settings.theme);
  const direction = useShell((s) => s.settings.direction);
  const contrast = useShell((s) => s.settings.contrast);
  const motion = useShell((s) => s.settings.motion);
  const screen = useShell((s) => s.screen);
  const agentDockOpen = useAgentDockOpen();
  // the date bar follows the open project whichever screen shows
  useTimelineSync();
  // a picture of the 3D view as a project's scene is left, for Change thumbnail
  useEffect(() => installLastView(), []);
  // stockpile projects: the volumes own the survey layers, the date bar mirrors them
  useEffect(
    () =>
      connectVolumeDates(volumetric, timeline, workspace, {
        isOpen: () => shell.getState().stageMode === 'split',
        onChange: (listener) =>
          shell.subscribe((s, p) => {
            if (s.stageMode !== p.stageMode) listener();
          }),
      }),
    [],
  );
  // Volume tools' Cut / fill: the survey engine compares the two surveys picked
  useEffect(
    () =>
      connectVolumeChange(volumetric, {
        site: (req, key) => engineClient().site(req, key),
        surfaces: () => compareStore.getState().surfaces,
      }),
    [],
  );

  useEffect(() => {
    // Settings and library are in: tell main the first screen is up (ends the first-start
    // watch after an update, ADR 0003).
    void shell
      .getState()
      .init()
      .finally(() => void bridge.call('app:rendererReady', {}));
    void jobs.getState().init();
    // the change producers of the Changes panel (C2 to C4), once
    registerAppChangeProducers();
    // a finished conversion (point cloud to COPC) adds a layer: reload the open manifest
    setPhotoRotator(async (layerId, photoId) => {
      const projectId = workspace.getState().project?.id;
      if (!projectId) return { ok: false, error: 'No project is open.' };
      const r = await bridge.call('builder:rotatePhoto', { projectId, layerId, photoId });
      if (!r.ok) return { ok: false, error: r.error };
      return r.value;
    });
    const stopFarWatch = startFarWatch();
    // line up dates: the step, its notice and the background check
    const stopLineUp = startLineUpSession();
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
    // a change run wrote its change set: the Changes panel reads the project's sets again
    const stopChangeReload = jobs.subscribe((s, prev) => {
      const project = workspace.getState().project;
      if (!project || !finishedChangeJob(prev.jobs, s.jobs, project.root)) return;
      void changeStore.getState().load(project.id);
    });
    // a volumetric build wrote volumes.json: piles it added become volume measurements, with no
    // carried kit figure (the engine computes theirs)
    const stopKitConvert = jobs.subscribe((s, prev) => {
      const project = workspace.getState().project;
      if (!project) return;
      const built = s.jobs.some(
        (j) =>
          j.status === 'done' &&
          j.pipeline === 'volumetric.build' &&
          sameFolder(j.project, project.root) &&
          prev.jobs.find((p) => p.id === j.id)?.status !== 'done',
      );
      if (built) void convertAfterJob(project.id);
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
        // the review keeps its own copy of the passes (the pipeline wrote the issue of each
        // accepted detection into them): read them again if it has this project loaded, so a
        // person who started the run from Detections sees the result and never saves over it.
        // (A review edit saved while the run was in progress is not repaired by this reload.)
        if (detections.getState().projectId === project.id) void loadDetections(project.id, true);
      });
    });
    // a job that ends is said aloud wherever the person is
    const stopJobAnnounce = watchJobEnds(jobs, ({ job, ok }) => {
      announce(
        t(ok ? 'announce.jobDone' : 'announce.jobFailed', { job: jobTitle(job.pipeline) }),
        ok ? 'polite' : 'assertive',
      );
    });
    // another project: quiet ids of jobs that are over go with it
    const stopQuietPrune = workspace.subscribe((s, prev) => {
      if (s.project?.id !== prev.project?.id) jobs.getState().pruneQuiet();
    });
    void initAuthor(bridge);
    // the agent's one conversation: it listens for as long as the app runs, whatever screen shows
    const stopAgent = startAgentSession();
    window.addEventListener('keydown', onKeyDown);
    // a control that disappears hands focus to its neighbours, else to the screen heading
    const stopFocus = keepFocusAlive(
      document,
      () =>
        document.querySelector<HTMLElement>('main h1') ??
        document.querySelector<HTMLElement>('main'),
    );
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
      sh.setRight(false);
      // picked in 3D: its photo (or video frame) opens beside the 3D view; an open evidence
      // pane follows the card to the next issue
      const ev = evidence.getState();
      if (sh.screen === 'scene' && ((fromScene && ev.enabled) || ev.open)) openEvidence(id);
    });
    const stopEvidence = startEvidenceSplit();
    // the workbench tabs start again with each project (pins stay)
    const stopWorkbench = startWorkbenchReset();
    // the Scene's agent drops to its line while a tool is live, unless the person sized it (D23)
    const stopAgentPane = startAgentPaneFollow();
    // a playing clip and running jobs are live tabs ("Video ●", "Jobs ●", D11, I-R62)
    const stopActivities = startActivityFollow();
    const stopOpenPath = openPackagesHandedOver();
    const stopMenu = followMenu();
    // M9: merges, imports and outside edits reload the records, keeping selection and camera
    const stopJournal = followJournalChanges();
    // My work's Conflicts and Quarantined lines open the Team dialog (the Conflicts inbox)
    collabStore.setState({
      openConflicts: () => {
        teamUi.getState().open('team');
      },
    });
    // issue chips and the register show the team's initials (T2); a team policy hides Approve
    const people = () => {
      const s = collabStore.getState();
      const initials: Record<string, string> = {};
      for (const p of [...s.members, ...(s.me ? [s.me] : [])]) initials[p.name] = p.initials;
      setAnnotationPeople({ initials, teamPolicy: s.state.policy !== null });
    };
    people();
    const stopCollab = collabStore.subscribe(people);
    const stopProject = workspace.subscribe((s, prev) => {
      if (s.project && s.project.id !== prev.project?.id) void loadCollab(s.project.id);
    });
    const stopPeople = () => {
      stopCollab();
      stopProject();
    };
    const stopRoad = startRoadSync();
    // A road survey opens map first.
    const stopRoadMode = roadStore.subscribe((s, prev) => {
      if (s.status === 'ready' && prev.status !== 'ready') shell.getState().setStageMode('map');
    });
    // a volumetric project opens its volumes (volumes.json beside the manifest): the kit piles'
    // outlines and 3D bodies only; their figures are their volume measurements' (survey engine)
    const stopVolumes = workspace.subscribe((s, prev) => {
      if (s.project !== prev.project) void volumetric.getState().load();
    });
    return () => {
      setPhotoRotator(null);
      stopOpenPath();
      stopWorkbench();
      stopAgentPane();
      stopActivities();
      stopMenu();
      stopJournal();
      stopPeople();
      stopJobReload();
      stopFarWatch();
      stopLineUp();
      stopChangeReload();
      stopIssueReload();
      stopKitConvert();
      stopRoad();
      stopRoadMode();
      stopAgent();
      window.removeEventListener('keydown', onKeyDown);
      stopFocus();
      stopJobAnnounce();
      stopQuietPrune();
      stopPlayback();
      stopContinue();
      stopCard();
      stopEvidence();
      stopVolumes();
    };
  }, []);

  // "+ New class..." in every picker creates through the class store (ANN-7)
  useEffect(() => registerClassCreator((label, extra) => createClass(label, extra)), []);
  useEffect(() => registerSeverityCreator((model) => createSeverityModel(model)), []);

  useEffect(() => {
    const dark = window.matchMedia(OS_QUERIES.dark);
    const more = window.matchMedia(OS_QUERIES.moreContrast);
    const still = window.matchMedia(OS_QUERIES.reducedMotion);
    const apply = () => {
      applyAppearance(
        document.documentElement,
        { theme, direction, contrast, motion },
        dark.matches,
        { moreContrast: more.matches, reducedMotion: still.matches },
      );
    };
    apply();
    for (const m of [dark, more, still]) m.addEventListener('change', apply);
    return () => {
      for (const m of [dark, more, still]) m.removeEventListener('change', apply);
    };
  }, [theme, direction, contrast, motion]);

  return (
    <div
      ref={sidebarSplitRef}
      className="app"
      data-sb={sidebar.folded ? 'collapsed' : 'expanded'}
      data-fold={sidebar.phase ?? undefined}
      onTransitionEnd={sidebar.onTransitionEnd}
      data-screen={screen}
      data-agent-dock={agentDockOpen ? 'open' : undefined}
      data-platform={PLATFORM}
      style={CAPTION_VARS}
    >
      <AnnotateStyles />
      <VolumetricStyles />
      <Sidebar resize={sidebarResize} />
      <main className="main">
        <Screen />
        <AgentDock />
      </main>
      <Palette />
      <ProcessingDrawer />
      <PipelineDialog />
      <UnlockDialog />
      <PackageExportDialog />
      <PanoImportDialog />
      <Toasts />
      <LineUpDialog />
      <ClassNotice />
      <LiveAnnouncer />
      <BuilderLayer />
      <DrawingsLayer />
      <ModellerLayer />
      <EngineerLayer />
      <RfLayer />
      <Lightbox />
      <RemoveHost />
      <AreaCompareHost />
      <LayerProperties />
      <SpotViewer />
      <ReportProblemDialog />
      <CrashNotice />
      <HelpPanel />
      <SyncHost />
    </div>
  );
}
