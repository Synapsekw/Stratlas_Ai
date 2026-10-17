import { registerAppHooks } from '@aio/ai';
import { SightingPicker, useIssueOverlay, useMapDraw, usePinDisplay } from '@aio/annotate';
import { getActiveScene, SceneView, type EngineStage } from '@aio/engine';
import { MapView, type MapController, type MapDrawSeam, type MapIssueDisplay } from '@aio/maps';
import { Button, Icon, useT } from '@aio/ui';
import { setDroneTelemetry, setFlightPaths, videoRig } from '@aio/video';
import { VolumetricStage } from '@aio/volumetric';
import { useWorkspace, workspace } from '@aio/workspace';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CloudChangeLegend } from '../change/producers/CloudChangeLegend';
import { useStageEnvironment } from '../environment/EnvironmentTool';
import { FocusZone } from '../FocusZone';
import { CloseupDock, MeasureBar, PciUnitCard, RoadLegend, useRoadKeys } from '../road/RoadTools';
import { useRoad } from '../road/store';
import { useRoadSetupMap } from '../road/RoadSetup';
import { useRoadMap } from '../road/useRoadMap';
import { photoSplitIsOpen } from '../builder/photoOpen';
import { shell, useShell } from '../shell';
import { PANEL_ID } from '../shell/PanelHandle';
import { FloatingVideo } from './FloatingVideo';
import { useAnnotateStageBridge } from './workbench/benches/annotateStage';
import {
  compareRuntime,
  linkMaps,
  primaryMap,
  primaryScene,
  useCaptureEpoch,
  useCompareNotice,
} from './compare';
import { CompareMap, useVolumesFollowDate } from './CompareControls';
import { CompareScene } from './CompareScene';
import { StageComponentBrief } from './ComponentBrief';
import { ChangeLegends } from './MapSwipe';
import { CursorReadout, useSceneCursor } from './SceneCursor';
import { StageClassLegend, StageElevationLegend } from './StageLegends';
import { CleanupHost } from '../pointcloud/CleanupHost';
import { DesignsMount } from '../survey/Designs';
import { HaulRoadMount } from '../survey/HaulRoad';
import { HydroMount } from '../survey/Hydro';
import './m8Mounts';
import { paneCapture, PaneChooser, SplitPane, useSplit } from './SplitPanes';
import {
  chooseCapture,
  followsFocus,
  PER_CAPTURE,
  sideOf,
  sidesOf,
  type FocusFollow,
  type Side,
} from './splitModel';
import { DatesOnScreen } from './DatesOnScreen';
import { useWalkMapOverlays, useWalkMapPointer } from '../walks/walkMapStore';
import { PlaceWalkHere } from '../walks/PlaceWalkStrip';
import { usePlacedWalksOnMap, usePlacingOn } from '../walks/placeWalk';
import { MAP_SURFACE, SCENE_SURFACE } from '../walks/placeModel';
import { WalkSceneMount } from '../walks/WalkSceneMount';
import { useTimeline } from './timeline';
import { hiddenPathClips } from './flightPaths';
import { telemetryLabels, useTelemetryOn } from './telemetryPref';
import { useFlightPathModel } from './pathModel';
import { useEngineStage } from './StageTools';
import { useStageKeys } from './stageKeys';
import {
  insideView,
  setCutawayMode,
  stopCutaway,
  useCutaway,
  useCutawayPref,
  useCutawayState,
} from './useCutaway';
import { Island } from './island/Island';
import { useIslandLinked } from './workbench/RightSidebar';
import { MeasureMount } from '../survey/MeasureToolbar';
import { SurveyQaMount } from '../survey/Qa';
import { useGroundFollowsLayers, useSiteBasemapLayer } from './siteBasemap';
import { useStreetMap3d } from './streetMap3d';
import { MapViewMenu, SceneMapMenu } from './MapMenus';
import { useSiteTiles } from './siteTiles';

function ScenePane({
  hidden,
  engine,
  side,
  capture,
  corner,
}: {
  hidden: boolean;
  engine: EngineStage | null;
  /** The split side it shows on. */
  side?: Side | undefined;
  /** The survey date its side shows (a split that shows dates). */
  capture?: string | undefined;
  corner?: ReactNode;
}) {
  const { cursor, onMove, onLeave } = useSceneCursor(getActiveScene);
  // with a date of its own the pane draws that survey's volumes, and its legends read its own
  // clouds (the other side of a comparison has its own legends)
  const epoch = useCaptureEpoch(capture);
  const view = capture ? engine : undefined;
  const placing = usePlacingOn('3d');

  return (
    <FocusZone
      kind="scene3d"
      className={`pane pane-3d${hidden ? ' is-hidden' : ''}${placing ? ' walk-placing' : ''}`}
      data-side={side}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      aria-hidden={hidden}
    >
      {/* the Place walk toolbar while a walk is placed in the 3D view (only while it shows) */}
      {!hidden && <PlaceWalkHere at={SCENE_SURFACE} />}
      <div className="fill">
        {/* one date at a time while the split shows dates (compare.ts) */}
        <SceneView className="scene-fill" store={primaryScene} />
      </div>
      <CursorReadout text={cursor} />
      {!hidden && <StageComponentBrief engine={engine} />}
      <StageElevationLegend view={view} />
      <VolumetricStage stage={engine} epoch={epoch} />
      <StageClassLegend view={view} />
      {!hidden && <CleanupHost engine={engine} />}
      <CloudChangeLegend view={view} />
      <ChangeLegends />
      {!hidden && <SceneMapMenu />}
      {corner}
    </FocusZone>
  );
}

/* ----------------------------------------------------------------------- right panel */

/** The right panel's toggle at the stage's top right (D17), beside the View tile and Ctrl+Alt+B. */
function RightPanelToggle() {
  const t = useT();
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  return (
    <div className="stage-rp overlay-box" data-surface="dark">
      <Button
        variant="icon"
        size="md"
        pressed={!rightCollapsed}
        aria-label={rightCollapsed ? t('island.tile.showRight') : t('island.tile.hideRight')}
        aria-controls={PANEL_ID.right}
        tip={t('island.toRightPanel')}
        shortcut="global.rightPanel"
        onClick={shell.getState().toggleRight}
      >
        <Icon name="sidebar" size={16} className="flip" />
      </Button>
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
  // Split: each side shows the pane chosen for it (3D and map by default).
  const split = useSplit();
  const splitting = mode === 'split';
  const sides = split.sides;
  // Comparing dates: the 3D view and the map at most once per date, so maybe on both sides.
  const sides3d = splitting ? sidesOf(sides, '3d') : [];
  const sidesMap = splitting ? sidesOf(sides, 'map') : [];
  const show3d = mode === '3d' || sides3d.length > 0;
  const showMap = mode === 'map' || sidesMap.length > 0;
  const videoPane = splitting && sideOf(sides, 'video') !== undefined;
  const at = (kind: '3d' | 'map') => (kind === '3d' ? sides3d[0] : sidesMap[0]);
  const chooser = (kind: '3d' | 'map') => {
    const side = at(kind);
    return side ? <PaneChooser side={side} split={split} /> : null;
  };
  const showVideo = activeClip !== null && !videoHidden && !videoPane;
  const engine = useEngineStage();
  const index = split.index;
  const linked = !sides.unlinked;
  // the sidebar shows the island's live item in front: the island says so (D10)
  const islandLinked = useIslandLinked();
  // the main 3D view and map show their side's date (null: as the layer tree says)
  const side3d = sides3d[0];
  const sideMap = sidesMap[0];
  const sceneCapture = side3d ? paneCapture(split, side3d) : undefined;
  const mapCapture = sideMap ? paneCapture(split, sideMap) : undefined;
  useEffect(() => {
    primaryScene.setScope(
      sceneCapture && index ? { capture: sceneCapture, index, mode: 'hide', camera: true } : null,
    );
  }, [sceneCapture, index]);
  useEffect(() => {
    primaryMap.setScope(
      mapCapture && index ? { capture: mapCapture, index, mode: 'hide', camera: true } : null,
    );
  }, [mapCapture, index]);
  useEffect(
    () => () => {
      primaryScene.setScope(null);
      primaryMap.setScope(null);
    },
    [],
  );
  // the left side follows the date bar's focused survey (only panes drawn per date) when the
  // date changes with the split open; opening the split keeps its first-left, last-right dates
  const focus = useTimeline((s) => s.focus);
  const lastFocus = useRef<FocusFollow>({ projectId, focus, splitting });
  useEffect(() => {
    const prev = lastFocus.current;
    lastFocus.current = { projectId, focus, splitting };
    if (!followsFocus(prev, lastFocus.current) || !focus || !split.dates) return;
    if (!PER_CAPTURE.includes(sides.left) || paneCapture(split, 'left') === focus) return;
    split.set(chooseCapture(split.sides, 'left', focus, split.dates));
  }, [projectId, focus, splitting]); // eslint-disable-line react-hooks/exhaustive-deps -- follow focus changes only
  useVolumesFollowDate(split, side3d, sceneCapture);
  const second3d = sides3d[1];
  const secondMap = sidesMap[1];
  const secondCapture3d = second3d ? paneCapture(split, second3d) : undefined;
  const secondCaptureMap = secondMap ? paneCapture(split, secondMap) : undefined;
  // linked pan and zoom of two maps
  const [maps, setMaps] = useState<[MapController | null, MapController | null]>([null, null]);
  const onMainMap = useCallback((c: MapController | null) => {
    setMaps((m) => [c, m[1]]);
  }, []);
  const onSecondMap = useCallback((c: MapController | null) => {
    setMaps((m) => [m[0], c]);
  }, []);
  useEffect(() => {
    compareRuntime.maps = maps;
    const [a, b] = maps;
    if (!a || !b || !linked || !secondMap) return;
    return linkMaps(a.map, b.map);
  }, [maps, linked, secondMap]);
  // The maps report null as they go, but after the stage itself (setMaps on an unmounted
  // component): without this the module-level slots kept the last, disposed map and its DOM.
  useEffect(
    () => () => {
      compareRuntime.maps = [null, null];
    },
    [],
  );
  const notice = useCompareNotice();
  const keepOut = useCallback(() => {
    const root = stageRef.current;
    if (!root) return [];
    return [
      ...root.querySelectorAll(
        '.island, .stage-rp, .stage-under > *, .vwin:not(.docked), .cursor-ro, .stage-pop, .surface-pop, .elev-legend, .pane-chooser, .vol-legend',
      ),
    ].map((e) => e.getBoundingClientRect());
  }, []);
  const mapDraw = useMapDraw(mapLayer);
  // the Annotate workbench draws the map tools from this and says which views are on
  useAnnotateStageBridge(mapDraw, show3d, showMap);
  const roadMap = useRoadMap();
  const roadSetup = useRoadSetupMap();
  // the walks' path, stills and pins (and the pointer session while placing one) on the main map
  const walkOverlays = useWalkMapOverlays();
  const walkPointer = useWalkMapPointer();
  const placingOnMap = usePlacingOn('map');
  // every visible, placed walk on the map at 60 % (the walk placed there draws itself)
  usePlacedWalksOnMap();
  const baseOverlays = roadMap ? roadMap.overlays : roadSetup?.overlays;
  const mapOverlays = useMemo(
    () => (walkOverlays.length === 0 ? baseOverlays : [...(baseOverlays ?? []), ...walkOverlays]),
    [baseOverlays, walkOverlays],
  );
  const closeupOn = useRoad((s) => s.closeup);
  const selectedIssue = useWorkspace((s) =>
    s.selection?.kind === 'issue' ? s.selection.id : null,
  );
  const hasPhoto = useRoad((s) => s.rows.some((r) => r.id === selectedIssue && r.photo));
  const closeup = roadMap !== null && closeupOn && hasPhoto && showMap;
  // road keys first: they run before the stage keys below
  useRoadKeys(roadMap !== null);
  // the pins of a survey date follow that date's layers as the 3D view shows them
  useIssueOverlay(primaryScene);
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
  // the offline street map under the site in 3D
  const project = useWorkspace((s) => s.project);
  const streetMap = useStreetMap3d();
  useSiteBasemapLayer(engine, project, streetMap.shown);
  // the street map and a flat landscape lie under the shown models: placed again as they change
  useGroundFollowsLayers(engine, primaryScene);
  // M10 G7: 3D Tiles, terrain and imagery around the site, the Satellite map
  useSiteTiles(engine, project, maps[0], maps[1]);

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

  // Drone telemetry (trace and HUD of the playing clip), per project, independent of the paths.
  const telemetry = useTelemetryOn();
  const tr = useT();
  useEffect(() => {
    if (!engine) return;
    setDroneTelemetry(engine, { on: telemetry, labels: telemetryLabels() });
  }, [engine, telemetry, tr]);

  // A photo picked from an issue's sightings opens in the Media photo viewer. A click on the
  // photo itself opens it in the split view first (photoOpen), and then stays on the scene.
  useEffect(
    () =>
      workspace.subscribe((s, prev) => {
        if (s.selection !== prev.selection && s.selection?.kind === 'photo' && !photoSplitIsOpen())
          shell.getState().go('media');
      }),
    [],
  );

  // The agent's camera tools: what the stage shows, and the 3D view for 3D-only moves.
  useEffect(
    () =>
      registerAppHooks({
        stageView: () => ({ show3d, showMap }),
        show3d: () => {
          if (!show3d) shell.getState().setStageMode('3d');
        },
      }),
    [show3d, showMap],
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
    engine.setLabelKeepOut(keepOut);
    return () => {
      engine.setLabelKeepOut(null);
    };
  }, [engine, keepOut]);

  // Leaving the map or the annotation tools stops a map drawing.
  const { setMode: setMapDrawMode } = mapDraw;
  useEffect(() => {
    if (!annotating || !showMap) setMapDrawMode(null);
  }, [annotating, showMap, setMapDrawMode]);

  // Stage shortcuts (single keys; the video annotator's own keys win inside the video window).
  useStageKeys(engine);

  const seam: MapDrawSeam = roadMap?.measure ??
    roadSetup?.seam ?? {
      mode: mapDraw.mode,
      vertices: mapDraw.state?.vertices ?? [],
      onClick: mapDraw.onClick,
      onFinish: mapDraw.finish,
    };

  return (
    <div
      className={`stage${docked && showVideo ? ' docked' : ''}`}
      ref={stageRef}
      data-mode={mode}
      data-pop-bounds
    >
      {/* 3D and map panes keep their geometry in a right-to-left UI. */}
      <div
        className={`stage-panes${docked && showVideo ? ' with-video' : ''}${closeup ? ' with-dock' : ''}`}
        data-mode={mode}
        dir="ltr"
      >
        <ScenePane
          hidden={!show3d}
          engine={engine}
          side={at('3d')}
          capture={sceneCapture}
          corner={chooser('3d')}
        />
        {second3d && secondCapture3d && index && (
          <CompareScene
            key={projectId}
            side={second3d}
            capture={secondCapture3d}
            index={index}
            main={engine}
            linked={linked}
            corner={<PaneChooser side={second3d} split={split} />}
            stageRef={stageRef}
            keepOut={keepOut}
          />
        )}
        {secondMap && secondCaptureMap && index && (
          <CompareMap
            key={projectId}
            side={secondMap}
            capture={secondCaptureMap}
            index={index}
            issues={mapIssues}
            onController={onSecondMap}
            corner={<PaneChooser side={secondMap} split={split} />}
          />
        )}
        {showMap && (
          <FocusZone
            kind="map"
            className={`pane pane-map${placingOnMap ? ' walk-placing' : ''}`}
            data-side={at('map')}
          >
            <PlaceWalkHere at={MAP_SURFACE} />
            <div className="fill">
              <MapView
                className="scene-fill"
                draw={seam}
                issues={mapIssues}
                store={primaryMap}
                onController={onMainMap}
                pointer={walkPointer}
                {...(mapOverlays ? { overlays: mapOverlays } : {})}
                {...(roadMap
                  ? {
                      issueFilter: roadMap.issueFilter,
                      issueColorBy: roadMap.issueColorBy,
                    }
                  : {})}
              />
            </div>
            <MapViewMenu />
            {roadMap && <RoadLegend />}
            <ChangeLegends />
            {roadMap && <PciUnitCard />}
            {chooser('map')}
          </FocusZone>
        )}
        {splitting && <SplitPane side="left" split={split} />}
        {splitting && <SplitPane side="right" split={split} />}
        {closeup && <CloseupDock />}
        {docked && showVideo && <FloatingVideo layerId={activeClip} docked stageRef={stageRef} />}
      </div>
      <Island
        stage={engine}
        mode={mode}
        tools={show3d ? (showMap ? 'split' : '3d') : 'map'}
        split={split}
        linked={islandLinked}
      />
      <RightPanelToggle />
      <MeasureMount stage={engine} />
      <WalkSceneMount stage={engine} />
      <SurveyQaMount />
      <HydroMount />
      <HaulRoadMount stage={engine} />
      <DesignsMount stage={engine} />
      <div className="stage-under" data-surface="dark">
        {roadMap && showMap && <MeasureBar />}
        {show3d && <StageStatus stage={engine} />}
        {notice && (
          <div className="stage-status" role="status">
            <span className="ss-chip compare-notice" data-testid="compare-notice">
              <Icon name="warn" size={14} />
              <span>{notice}</span>
            </span>
          </div>
        )}
      </div>
      {!splitting && (
        <DatesOnScreen kinds={['mesh', 'pointcloud', 'raster', 'vector', 'panoramas']} />
      )}
      <SightingPicker kinds={['map']} />
      <SightingPicker kinds={['mesh', 'pointcloud']} />
      {!docked && showVideo && (
        <FloatingVideo layerId={activeClip} docked={false} stageRef={stageRef} />
      )}
    </div>
  );
}
