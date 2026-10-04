import {
  AnnotationToolbar,
  SightingPicker,
  annotateUi,
  pinDisplay,
  useIssueOverlay,
  useMapDraw,
  usePinDisplay,
  type MapDraw,
} from '@aio/annotate';
import { getActiveScene, SceneView, type EngineStage } from '@aio/engine';
import { MapView, type MapDrawMode, type MapDrawSeam, type MapIssueDisplay } from '@aio/maps';
import {
  ClassificationLegend,
  ElevationLegend,
  pointcloudSettings,
  useClassificationLegend,
  useElevationRange,
} from '@aio/pointcloud';
import { crsLabel, formatEastNorth, Icon, localToProject, useT, type IconName } from '@aio/ui';
import { setFlightPaths, videoRig } from '@aio/video';
import { useVolumetric, VolumetricStage } from '@aio/volumetric';
import { useWorkspace, workspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { EnvironmentTool, useStageEnvironment } from '../environment/EnvironmentTool';
import { FocusZone } from '../FocusZone';
import {
  CloseupDock,
  MeasureBar,
  PciUnitCard,
  RoadLegend,
  RoadToolGroup,
  useRoadKeys,
} from '../road/RoadTools';
import { useRoad } from '../road/store';
import { useRoadSetupMap } from '../road/RoadSetup';
import { useRoadMap } from '../road/useRoadMap';
import { isTyping } from '../keys';
import { shell, useShell } from '../shell';
import type { StageMode } from '../store';
import { FloatingVideo } from './FloatingVideo';
import { PaneChooser, SplitPane, useSplit } from './SplitPanes';
import { sideOf, type Side } from './splitModel';
import { hiddenPathClips, togglePaths } from './flightPaths';
import { flightPathModel, updateFlightPaths, useFlightPathModel } from './pathModel';
import {
  AnnotateToggle,
  CloudTools,
  DisplayTools,
  MeasureTools,
  nextLabelMode,
  PopTool,
  toggleSection,
  Tool,
  useEngineStage,
  VideoTools,
  ViewTools,
} from './StageTools';
import { fitGroups, GAP, GROUP_LABEL, type GroupId } from './toolbarFit';
import { toggleTimeline } from './timelinePref';
import {
  insideView,
  setCutawayMode,
  stopCutaway,
  useCutaway,
  useCutawayPref,
  useCutawayState,
} from './useCutaway';
import { VolumeTools } from './VolumeTools';

const MODES: { mode: StageMode; label: string; icon: IconName; keys: string }[] = [
  { mode: '3d', label: '3D', icon: 'scene', keys: '1' },
  { mode: 'map', label: 'Map', icon: 'map', keys: '2' },
  { mode: 'split', label: 'Split', icon: 'split', keys: '3' },
];

function CursorReadout({ text }: { text: string | null }) {
  const crs = useWorkspace((s) => (s.project ? crsLabel(s.project.manifest.crs) : ''));
  return (
    <div className="cursor-ro" aria-live="off">
      {crs}
      <br />
      {text ?? 'Point at the scene for coordinates'}
    </div>
  );
}

/** The elevation ramp and its range in metres while the clouds are coloured by elevation. */
function StageElevationLegend() {
  const range = useElevationRange();
  const origin = useWorkspace((s) => s.project?.manifest.origin);
  return (
    <ElevationLegend
      className="elev-legend overlay-box"
      range={range}
      toElevation={(y) => (origin ? localToProject(origin, [0, y, 0])[2] : y)}
    />
  );
}

/** The classes of the shown points while the clouds are coloured by classification. */
function StageClassLegend() {
  const { counts, hidden } = useClassificationLegend();
  return (
    <ClassificationLegend
      className="elev-legend class-legend overlay-box"
      counts={counts}
      hidden={hidden}
      onToggle={(c) => {
        pointcloudSettings.getState().toggleClass(c);
      }}
    />
  );
}

function ScenePane({
  hidden,
  engine,
  side,
  corner,
}: {
  hidden: boolean;
  engine: EngineStage | null;
  /** The split side it shows on. */
  side?: Side | undefined;
  corner?: ReactNode;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    pending.current = {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: -(((e.clientY - r.top) / r.height) * 2 - 1),
    };
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const p = pending.current;
      const h = getActiveScene();
      const project = workspace.getState().project;
      if (!p || !h || !project) return;
      const hit = h.raycast(p.x, p.y);
      if (!hit) {
        setCursor(null);
        return;
      }
      const [e2, n, el] = localToProject(project.manifest.origin, [
        hit.point.x,
        hit.point.y,
        hit.point.z,
      ]);
      setCursor(`${formatEastNorth(e2, n)} · EL ${el.toFixed(1)} m`);
    });
  };

  return (
    <FocusZone
      kind="scene3d"
      className={`pane pane-3d${hidden ? ' is-hidden' : ''}`}
      data-side={side}
      onPointerMove={onMove}
      onPointerLeave={() => {
        setCursor(null);
      }}
      aria-hidden={hidden}
    >
      <div className="fill">
        <SceneView className="scene-fill" />
      </div>
      <CursorReadout text={cursor} />
      <StageElevationLegend />
      <VolumetricStage stage={engine} />
      <StageClassLegend />
      {corner}
    </FocusZone>
  );
}

/* ----------------------------------------------------------------------- toolbar */

function StageToolbar({
  stage,
  mode: stageMode,
  tools,
  barRef,
}: {
  stage: EngineStage | null;
  mode: StageMode;
  /** The panes the tools work on (a split may show neither the 3D view nor the map). */
  tools: StageMode;
  barRef: RefObject<HTMLDivElement | null>;
}) {
  const mode = tools;
  const road = useRoad((s) => s.status === 'ready');
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  const cloudPanelOpen = useShell((s) => s.cloudPanelOpen);
  const hasClouds = useWorkspace((s) =>
    (s.project?.manifest.layers ?? []).some((l) => l.kind === 'pointcloud'),
  );
  const hasVolumes = useVolumetric((s) => s.status === 'ready');
  const map = mode === 'map';
  const groups: GroupId[] = useMemo(() => {
    const base: GroupId[] = map
      ? ['view', 'display', 'video', 'annotate']
      : hasVolumes
        ? ['view', 'measure', 'volumes', 'display', 'video', 'annotate']
        : hasClouds
          ? ['view', 'measure', 'display', 'clouds', 'video', 'annotate']
          : ['view', 'measure', 'display', 'video', 'annotate'];
    // the road tools work on the map
    return road && mode !== '3d' ? [...base.slice(0, -1), 'road', 'annotate'] : base;
  }, [map, hasClouds, hasVolumes, road, mode]);
  const [moreOpen, setMoreOpen] = useState(false);
  const widths = useRef(new Map<GroupId, number>());
  const [hidden, setHidden] = useState<GroupId[]>([]);

  const fit = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    for (const el of bar.querySelectorAll<HTMLElement>('[data-group]'))
      widths.current.set(el.dataset.group as GroupId, el.offsetWidth);
    let fixed = 0;
    for (const el of bar.querySelectorAll<HTMLElement>('[data-fixed]'))
      fixed += el.offsetWidth + GAP;
    const next = fitGroups(groups, widths.current, fixed, bar.clientWidth);
    setHidden((prev) => (prev.join() === next.join() ? prev : next));
  }, [barRef, groups]);

  useLayoutEffect(fit);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    return () => {
      ro.disconnect();
    };
  }, [barRef, fit]);

  const render = (g: GroupId): ReactNode => {
    switch (g) {
      case 'view':
        return <ViewTools stage={stage} map={map} />;
      case 'measure':
        return <MeasureTools stage={stage} />;
      case 'display':
        return <DisplayTools stage={stage} map={map} />;
      case 'clouds':
        return <CloudTools />;
      case 'volumes':
        return <VolumeTools />;
      case 'video':
        return <VideoTools stage={stage} map={map} />;
      case 'annotate':
        return <AnnotateToggle />;
      case 'road':
        return <RoadToolGroup />;
    }
  };

  return (
    <div className="stbar" ref={barRef}>
      <div className="seg overlay-seg" role="group" aria-label="Stage view" data-fixed="">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            aria-pressed={stageMode === m.mode}
            aria-keyshortcuts={m.keys}
            aria-label={m.label}
            title={`${m.label} (${m.keys})`}
            onClick={() => {
              shell.getState().setStageMode(m.mode);
            }}
          >
            <Icon name={m.icon} size={14} />
            <span className="mode-l">{m.label}</span>
          </button>
        ))}
      </div>
      {groups
        .filter((g) => !hidden.includes(g))
        .map((g) => (
          <div
            key={g}
            className="tgroup-h overlay-box"
            role="group"
            aria-label={GROUP_LABEL[g]}
            data-group={g}
          >
            {render(g)}
          </div>
        ))}
      {hidden.length > 0 && (
        <div className="tgroup-h overlay-box">
          <PopTool
            icon="more"
            label="More tools"
            // the point cloud panel opened from the sidebar or palette opens More when it is there
            open={moreOpen || (cloudPanelOpen && hidden.includes('clouds'))}
            onOpenChange={(o) => {
              setMoreOpen(o);
              if (!o && hidden.includes('clouds')) shell.getState().setCloudPanel(false);
            }}
          >
            <div className="ovf">
              {groups
                .filter((g) => hidden.includes(g))
                .map((g) => (
                  <div className="ovf-row" key={g} role="group" aria-label={GROUP_LABEL[g]}>
                    <span className="ovf-h">{GROUP_LABEL[g]}</span>
                    <div className="tgroup-h">{render(g)}</div>
                  </div>
                ))}
            </div>
          </PopTool>
        </div>
      )}
      <span className="stbar-sp" />
      {!map && stage && (
        <div className="tgroup-h overlay-box env-slot" data-fixed="">
          <EnvironmentTool stage={stage} />
        </div>
      )}
      <div className="tgroup-h overlay-box" data-fixed="">
        <button
          type="button"
          className="tool"
          aria-pressed={!rightCollapsed}
          aria-label={rightCollapsed ? 'Show the right panel' : 'Hide the right panel'}
          aria-keyshortcuts="Control+Alt+B"
          onClick={shell.getState().toggleRight}
        >
          <Icon name="sidebar" className="flip" />
          <span className="tip tip-end">
            Right panel <span className="kbd">Ctrl Alt B</span>
          </span>
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- annotate bar */

const MAP_MODES: { mode: MapDrawMode; label: string; title: string }[] = [
  { mode: 'point', label: 'Point', title: 'Map point' },
  { mode: 'line', label: 'Line', title: 'Map line (double-click or Enter to finish)' },
  { mode: 'polygon', label: 'Area', title: 'Map area (double-click or Enter to close)' },
];

function MapDrawTools({ draw }: { draw: MapDraw }) {
  const { mode, finish, undo, cancel, setMode } = draw;
  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || annotateUi.getState().pending) return;
      if (e.key === 'Enter') finish();
      else if (e.key === 'Backspace') undo();
      else if (e.key === 'Escape') {
        cancel();
        setMode(null);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [mode, finish, undo, cancel, setMode]);
  return (
    <div className="ann-toolbar stage-ann" role="toolbar" aria-label="Map annotation tools">
      <span className="ann-cap">Map</span>
      {MAP_MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          className="ann-btn ghost"
          aria-pressed={mode === m.mode}
          title={m.title}
          onClick={() => {
            setMode(mode === m.mode ? null : m.mode);
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------------- status */

/** What plays in 3D, and how the asset is opened (chosen by hand) when the drone is inside it. */
function StageStatus({ stage }: { stage: EngineStage | null }) {
  const t = useT();
  const playing = useWorkspace((s) => s.playing);
  const clip = useWorkspace((s) =>
    s.activeClip ? s.project?.manifest.layers.find((l) => l.id === s.activeClip) : undefined,
  );
  const inside = useCutawayState((s) => s.inside);
  const engaged = useCutawayState((s) => s.engaged);
  const { mode } = useCutawayPref();
  const open = engaged && mode !== 'off';
  if (!clip && !open) return null;
  return (
    <div className="stage-status" role="status">
      {clip && (
        <span className={`ss-chip${playing ? ' live' : ''}`}>
          <i aria-hidden />
          <b>{playing ? 'Playing' : 'Paused'}</b>
          <span className="ss-name">{clip.name}</span>
        </span>
      )}
      {stage && (open || inside) && (
        <span className="ss-chip ss-cut" data-testid="cutaway-status">
          <Icon name="cutaway" size={14} />
          <span>
            {!open
              ? t('stage.cutaway.droneInside')
              : mode === 'transparent'
                ? t('stage.cutaway.seeThrough')
                : inside
                  ? t('stage.cutaway.cutAtDrone')
                  : t('stage.cutaway.cutOpen')}
          </span>
          {open ? (
            <button
              type="button"
              className="btn sm ghost"
              title={t('stage.cutaway.solidTip')}
              onClick={() => {
                stopCutaway();
                stage.requestRender();
              }}
            >
              {t('stage.cutaway.solid')}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  setCutawayMode('cut');
                }}
              >
                {t('stage.cutaway.cut')}
              </button>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  setCutawayMode('transparent');
                }}
              >
                {t('stage.cutaway.transparent')}
              </button>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  if (videoRig(stage).cameraMode === 'drone') return;
                  insideView(stage);
                }}
              >
                {t('stage.cutaway.insideView')} <span className="kbd">C</span>
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------- stage */

/** Map sightings go on the project's first map layer (or the plain basemap). */
function mapLayerId(layers: readonly { id: string; kind: string }[]): string {
  return layers.find((l) => l.kind === 'basemap' || l.kind === 'raster')?.id ?? 'basemap';
}

export function Stage() {
  const mode = useShell((s) => s.stageMode);
  const docked = useShell((s) => s.videoDocked);
  const videoHidden = useShell((s) => s.videoHidden);
  const labelMode = useShell((s) => s.labelMode);
  const annotating = useShell((s) => s.annotating);
  const activeClip = useWorkspace((s) => s.activeClip);
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const mapLayer = useWorkspace((s) => mapLayerId(s.project?.manifest.layers ?? []));
  const stageRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // Split: each side shows the pane chosen for it (3D and map by default).
  const split = useSplit();
  const splitting = mode === 'split';
  const sides = split.sides;
  const show3d = mode === '3d' || (splitting && sideOf(sides, '3d') !== undefined);
  const showMap = mode === 'map' || (splitting && sideOf(sides, 'map') !== undefined);
  const videoPane = splitting && sideOf(sides, 'video') !== undefined;
  const photoSide = splitting && sideOf(sides, 'photo') !== undefined;
  const photoPane = useRef(photoSide);
  useEffect(() => {
    photoPane.current = photoSide;
  }, [photoSide]);
  const at = (kind: '3d' | 'map') => (splitting ? sideOf(sides, kind) : undefined);
  const chooser = (kind: '3d' | 'map') => {
    const side = at(kind);
    return side ? <PaneChooser side={side} split={split} /> : null;
  };
  const showVideo = activeClip !== null && !videoHidden && !videoPane;
  const engine = useEngineStage();
  const mapDraw = useMapDraw(mapLayer);
  const roadMap = useRoadMap();
  const roadSetup = useRoadSetupMap();
  const isRoad = roadMap !== null;
  const closeupOn = useRoad((s) => s.closeup);
  const selectedIssue = useWorkspace((s) =>
    s.selection?.kind === 'issue' ? s.selection.id : null,
  );
  const hasPhoto = useRoad((s) => s.rows.some((r) => r.id === selectedIssue && r.photo));
  const closeup = roadMap !== null && closeupOn && hasPhoto && showMap;
  // road keys first: they run before the stage keys below
  useRoadKeys(roadMap !== null);
  useIssueOverlay();
  // The Pins control drives the map markers too.
  const pinFilter = usePinDisplay((s) => s.filter);
  const pinHeat = usePinDisplay((s) => s.heat);
  const mapIssues = useMemo<MapIssueDisplay>(
    () => ({
      show: pinFilter !== 'off',
      minSeverity: typeof pinFilter === 'number' ? pinFilter : null,
      heat: pinHeat,
    }),
    [pinFilter, pinHeat],
  );
  useCutaway(engine);
  // sky or studio, time of day and water, per project
  useStageEnvironment(engine);

  // Flight paths: all, the active clip's flight only, or none, and single hidden flights.
  const paths = useFlightPathModel();
  const pathPref = paths?.pref;
  const pathFlights = paths?.flights;
  useEffect(() => {
    if (!engine || !pathPref || !pathFlights) return;
    setFlightPaths(engine, {
      mode: pathPref.mode,
      hiddenClips: hiddenPathClips(pathPref, pathFlights),
    });
  }, [engine, pathPref, pathFlights]);

  // A photo picked in 3D (or from an issue's sightings) opens in the Media photo viewer.
  useEffect(
    () =>
      workspace.subscribe((s, prev) => {
        // (unless a split side shows photos: the photo opens there)
        if (s.selection !== prev.selection && s.selection?.kind === 'photo' && !photoPane.current)
          shell.getState().go('media');
      }),
    [],
  );

  // Leaving and returning to Scene keeps the camera, per project.
  useEffect(() => {
    if (!engine || !projectId) return;
    const saved = shell.getState().views[projectId];
    if (saved) engine.restoreView(saved);
    return () => {
      shell.getState().saveView(projectId, engine.saveView());
    };
  }, [engine, projectId]);

  useEffect(() => {
    engine?.setLabelMode(labelMode);
  }, [engine, labelMode]);

  // Callouts keep clear of the toolbars, the floating video window and the readouts.
  useEffect(() => {
    if (!engine) return;
    engine.setLabelKeepOut(() => {
      const root = stageRef.current;
      if (!root) return [];
      return [
        ...root.querySelectorAll(
          '.stbar > :not(.stbar-sp), .stage-under > *, .vwin:not(.docked), .cursor-ro, .stage-pop, .elev-legend, .pane-chooser',
        ),
      ].map((e) => e.getBoundingClientRect());
    });
    return () => {
      engine.setLabelKeepOut(null);
    };
  }, [engine]);

  // Leaving the map or the annotation tools stops a map drawing.
  const { setMode: setMapDrawMode } = mapDraw;
  useEffect(() => {
    if (!annotating || !showMap) setMapDrawMode(null);
  }, [annotating, showMap, setMapDrawMode]);

  // Stage shortcuts (single keys; the video annotator's own keys win inside the video window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target) || annotateUi.getState().pending) return;
      if (e.target instanceof HTMLElement && e.target.closest('.vwin')) return;
      const sh = shell.getState();
      const ws = workspace.getState();
      const k = e.key.toLowerCase();
      const three = sh.stageMode !== 'map' ? engine : null;
      if (k === '1' || k === '2' || k === '3') {
        sh.setStageMode(k === '1' ? '3d' : k === '2' ? 'map' : 'split');
      } else if (k === 'h') ws.flyTo({ kind: 'home' });
      else if (k === 'f' && ws.selection) ws.flyTo({ kind: 'selection', selection: ws.selection });
      else if (k === 'm' && three) three.setTool(three.tool === 'measure' ? 'select' : 'measure');
      else if (k === 'x' && three) toggleSection(three);
      else if (k === 'l' && three) sh.setLabelMode(nextLabelMode(sh.labelMode));
      else if (k === 'a') sh.setAnnotating(!sh.annotating);
      else if (k === 'w' && ws.activeClip) sh.setVideoHidden(!sh.videoHidden);
      else if (k === 'p' && three && flightPathModel()) updateFlightPaths(togglePaths);
      else if (k === 'i') pinDisplay.getState().togglePins();
      else if (k === 't' && !isRoad) toggleTimeline(ws.project);
      else if (k === 'c' && three && ws.activeClip) insideView(three);
      else if (k === 'escape' && three && three.tool !== 'select') three.setTool('select');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [engine, isRoad]);

  const seam: MapDrawSeam = roadMap?.measure ??
    roadSetup?.seam ?? {
      mode: mapDraw.mode,
      vertices: mapDraw.state?.vertices ?? [],
      onClick: mapDraw.onClick,
      onFinish: mapDraw.finish,
    };

  return (
    <div className={`stage${docked && showVideo ? ' docked' : ''}`} ref={stageRef} data-mode={mode}>
      {/* 3D and map panes keep their geometry in a right-to-left UI. */}
      <div
        className={`stage-panes${docked && showVideo ? ' with-video' : ''}${closeup ? ' with-dock' : ''}`}
        data-mode={mode}
        dir="ltr"
      >
        <ScenePane hidden={!show3d} engine={engine} side={at('3d')} corner={chooser('3d')} />
        {showMap && (
          <FocusZone kind="map" className="pane pane-map" data-side={at('map')}>
            <div className="fill">
              <MapView
                className="scene-fill"
                draw={seam}
                issues={mapIssues}
                {...(roadMap
                  ? {
                      overlays: roadMap.overlays,
                      issueFilter: roadMap.issueFilter,
                      issueColorBy: roadMap.issueColorBy,
                      cameraWedge: mode === 'split',
                    }
                  : roadSetup
                    ? { overlays: roadSetup.overlays }
                    : {})}
              />
            </div>
            {roadMap && <RoadLegend />}
            {roadMap && <PciUnitCard />}
            {chooser('map')}
          </FocusZone>
        )}
        {splitting && <SplitPane side="left" split={split} />}
        {splitting && <SplitPane side="right" split={split} />}
        {closeup && <CloseupDock />}
        {docked && showVideo && <FloatingVideo layerId={activeClip} docked stageRef={stageRef} />}
      </div>
      <StageToolbar
        stage={engine}
        mode={mode}
        tools={show3d ? (showMap ? 'split' : '3d') : 'map'}
        barRef={barRef}
      />
      <div className="stage-under">
        {annotating && (
          <div className="ann-subbar overlay-box" role="group" aria-label="Annotation tools">
            {show3d && <AnnotationToolbar className="stage-ann" />}
            {showMap && <MapDrawTools draw={mapDraw} />}
            <Tool
              icon="x"
              label="Close the annotation tools"
              keys="A"
              onClick={() => {
                shell.getState().setAnnotating(false);
              }}
            />
          </div>
        )}
        {roadMap && showMap && <MeasureBar />}
        {show3d && <StageStatus stage={engine} />}
      </div>
      <SightingPicker kinds={['map']} />
      {!docked && showVideo && (
        <FloatingVideo layerId={activeClip} docked={false} stageRef={stageRef} />
      )}
    </div>
  );
}
