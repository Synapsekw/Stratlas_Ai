import { registerAppHooks } from '@aio/ai';
import { SightingPicker, useIssueOverlay, useMapDraw, usePinDisplay } from '@aio/annotate';
import { getActiveScene, SceneView, type EngineStage } from '@aio/engine';
import { MapView, type MapController, type MapDrawSeam, type MapIssueDisplay } from '@aio/maps';
import { Button, Icon, useT } from '@aio/ui';
import { setDroneTelemetry, setFlightPaths, videoRig } from '@aio/video';
import { useVolumeHint, VolumeHint, VolumetricStage } from '@aio/volumetric';
import { useWorkspace, workspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
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
import { FloatingVideo, VideoDock } from './FloatingVideo';
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
import { VolumeSection } from './VolumeSection';
import { CleanupHost } from '../pointcloud/CleanupHost';
import { DesignsMount } from '../survey/Designs';
import { PreparingCardView, usePreparingCard } from '../survey/PreparingCard';
import { HaulRoadMount } from '../survey/HaulRoad';
import { HydroMount } from '../survey/Hydro';
import './m8Mounts';
import { paneCapture, PaneHeader, SplitPane, useSplit, useSplitDivider } from './SplitPanes';
import {
  chooseCapture,
  followsFocus,
  PER_CAPTURE,
  sideOf,
  sidesOf,
  type FocusFollow,
  type Side,
} from './splitModel';
import { DatesOnScreen, datesOnScreen } from './DatesOnScreen';
import { useWalkMapOverlays, useWalkMapPointer } from '../walks/walkMapStore';
import { PlaceWalkHere } from '../walks/PlaceWalkStrip';
import { usePlacedWalksOnMap, usePlacingOn } from '../walks/placeWalk';
import { MAP_SURFACE, SCENE_SURFACE } from '../walks/placeModel';
import { useCompareFollowsStage } from '../walks/walkCompare';
import { WalkSceneMount } from '../walks/WalkSceneMount';
import { useTimeline } from './timeline';
import { hiddenPathClips } from './flightPaths';
import { telemetryLabels, useTelemetryOn } from './telemetryPref';
import { useFlightPathModel } from './pathModel';
import { useEngineStage } from './StageTools';
import { StageHint, useStageHintShown } from './StageHint';
import { StageShow, useStageShowShown } from './StageShow';
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
import { useIslandLinked } from './workbench/view';
import { MeasureMount } from '../survey/MeasureToolbar';
import { SurveyQaMount } from '../survey/Qa';
// --- telecom antenna runner (telecom-ui) ---
import { AntennaRunner } from '../telecom/AntennaRunner';
// --- end telecom antenna runner ---
import { useGroundFollowsLayers, useSiteBasemapLayer } from './siteBasemap';
import { useStreetMap3d } from './streetMap3d';
import { StageBasemapChip, useStageBasemap } from './MapMenus';
import { assignSlots, type Corner, type SlotRequest } from './overlaySlots';
import { useSiteTiles } from './siteTiles';
// --- RF coverage legend (rf-ui) ---
import { StageCoverageLegend, useCoverageLegendShown } from '../rf/StageCoverageLegend';
// --- end RF coverage legend ---

function ScenePane({
  hidden,
  engine,
  side,
  capture,
  corner,
  cursorHidden = false,
  cursorWide = false,
}: {
  hidden: boolean;
  engine: EngineStage | null;
  /** The split side it shows on. */
  side?: Side | undefined;
  /** The survey date its side shows (a split that shows dates). */
  capture?: string | undefined;
  corner?: ReactNode;
  /** The stage corner of the coordinates readout went to another overlay (D30). */
  cursorHidden?: boolean;
  /** The other bottom corner is free: the readout may take the width of the foot. */
  cursorWide?: boolean;
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
      {!cursorHidden && <CursorReadout text={cursor} wide={cursorWide} />}
      {!hidden && <StageComponentBrief engine={engine} />}
      <StageElevationLegend view={view} />
      {/* the "Click a pile" hint takes a corner slot of the stage (I-R51) */}
      <VolumetricStage stage={engine} epoch={epoch} hint={false} />
      {/* the drawn section line's panel and profile (Volume tools' section line) */}
      <VolumeSection />
      <StageClassLegend view={view} />
      {!hidden && <CleanupHost engine={engine} />}
      <CloudChangeLegend view={view} />
      <ChangeLegends />
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

/** Whether the cut-away chip shows: the asset opened by hand, or the drone inside it. */
function useCutawayStatus(stage: EngineStage | null) {
  const inside = useCutawayState((s) => s.inside);
  const engaged = useCutawayState((s) => s.engaged);
  const { mode } = useCutawayPref();
  const open = engaged && mode !== 'off';
  return { inside, open, mode, shown: stage !== null && (open || inside) };
}

/**
 * How the asset is opened (chosen by hand) when the drone is inside it. What plays is the island's
 * live item, so no playing or paused chip shows here (D30).
 */
function StageStatus({ stage }: { stage: EngineStage | null }) {
  const t = useT();
  const { inside, open, mode, shown } = useCutawayStatus(stage);
  if (!shown) return null;
  return (
    <div className="stage-status" role="status">
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

/* ----------------------------------------------------------------------- corners */

const NO_CORNERS: readonly Corner[] = [];

/** The layer kinds whose survey dates the dates chip lists. */
const DATE_KINDS = ['mesh', 'pointcloud', 'raster', 'vector', 'panoramas'] as const;

/** Whether the survey dates chip shows: two dates or more on screen (DatesOnScreen). */
function useDatesShown(): boolean {
  const index = useTimeline((s) => s.index);
  const hidden = useWorkspace((s) => s.hidden);
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  return useMemo(
    () => !!index && !!layers && datesOnScreen(index, hidden, layers, DATE_KINDS).length >= 2,
    [index, hidden, layers],
  );
}

export interface StageCornersInput {
  engine: EngineStage | null;
  show3d: boolean;
  showMap: boolean;
  splitting: boolean;
  /** The road map's measuring bar is up. */
  roadMeasure: boolean;
  /** The corners the floating video takes as it rests (none: docked, hidden or no clip). */
  video: readonly Corner[];
  /** The stage corner the 3D view's coordinates readout stands in (null: not at a corner). */
  cursor: Corner | null;
  /**
   * The readout stands clear of that corner's volumes hint: the 3D view on the left of a split,
   * in a pane wide enough, has it at the pane's end beside the divider, so the hint at the pane's
   * foot does not hide it (anything else in the corner still does).
   */
  readoutClear?: boolean;
  /** The corners the Map menu chip wants: at the map's side of a split (default: the end). */
  basemapAt?: readonly Corner[];
  /**
   * The top corners the open island reaches across and past the middle of the stage: not free,
   * or an overlay pushed under it would meet the bottom ones (useIslandReach).
   */
  topTaken?: readonly TopCorner[];
  // --- RF coverage legend (rf-ui) ---
  /** The coverage legend wants a bottom corner: the Coverage layer is on and draws something. */
  rfLegend: boolean;
  // --- end RF coverage legend ---
}

const END: readonly Corner[] = ['tr', 'br'];
const START: readonly Corner[] = ['tl', 'bl'];

/**
 * The corners the stage's Map menu chip wants: in a split, the side of the pane whose view it
 * serves (the map's, else the 3D view's; the panes keep left to right), so it never stands over
 * the other pane, a 360 walk say; else the stage's end.
 */
export function basemapCorners(
  view: 'map' | 'scene' | null,
  sideMap: Side | undefined,
  side3d: Side | undefined,
  splitting: boolean,
  rtl: boolean,
): readonly Corner[] {
  const side = !splitting ? undefined : view === 'map' ? sideMap : side3d;
  return side !== undefined && (side === 'left') !== rtl ? START : END;
}

/** The corners the volumes hint wants, given the readout's corner. */
function hintCorners(cursor: Corner | null, splitting: boolean): Corner[] {
  if (splitting && cursor) return [cursor];
  return cursor === 'bl' ? ['br', 'bl'] : ['bl', 'br'];
}

/**
 * The stage corner the 3D view's coordinates readout stands in: the foot of the stage's end, or
 * in a split the quarter of the stage its side's pane takes (the panes keep left to right, so
 * the left pane is the end right to left), where a floating video or a corner overlay may
 * hide it. Null without a 3D view.
 */
export function readoutCorner(
  show3d: boolean,
  side: Side | undefined,
  rtl: boolean,
): Corner | null {
  if (!show3d) return null;
  if (side === 'left') return rtl ? 'br' : 'bl';
  return rtl ? 'bl' : 'br';
}

/**
 * The stage's corner overlays (D30), each in a corner of its own around the top-centre island:
 * the floating video where it rests, the status chips, the one Map menu chip, the survey dates and
 * the coordinates readout, served in that order; one left without a free corner is hidden. The
 * telemetry is the island's live line and the Video workbench, never a box on the model.
 */
export function useStageCorners(o: StageCornersInput): {
  cursorHidden: boolean;
  cursorWide: boolean;
  corners: ReactNode;
} {
  const notice = useCompareNotice();
  const cutaway = useCutawayStatus(o.engine).shown && o.show3d;
  const basemap = useStageBasemap(o.show3d, o.showMap);
  const dates = useDatesShown() && !o.splitting;
  const volHint = useVolumeHint() && o.show3d;
  // what the pointer and Esc do now (the linked hover, an open pile): the foot of the stage
  const stageHint = useStageHintShown();
  // survey surfaces preparing (board 7): the foot of the stage, the corner away from the readout
  const preparing = usePreparingCard();
  const prepShown = preparing !== null;
  // the one Show control, top-left while the Volumes tab is open (board 1)
  const show = useStageShowShown();
  const status = o.roadMeasure || cutaway || notice !== null;
  const basemapAt = o.basemapAt ?? END;
  const topTaken = o.topTaken ?? NO_CORNERS;
  const slots = useMemo(() => {
    const items: SlotRequest[] = [
      ...o.video.map((c) => ({ id: `video-${c}`, want: [c] })),
      // the top corners the open island reaches across and past the middle
      ...topTaken.map((c) => ({ id: `island-${c}`, want: [c] })),
      { id: 'show', want: show ? ['tl'] : [] },
      { id: 'status', want: status ? ['tl', 'bl'] : [] },
      { id: 'basemap', want: basemap ? basemapAt : [] },
      {
        id: 'preparing',
        want: prepShown ? (o.cursor === 'bl' ? ['br', 'bl'] : ['bl', 'br']) : [],
      },
      { id: 'stageHint', want: stageHint ? hintCorners(o.cursor, o.splitting) : [] },
      // the volumes hint at the foot, the corner away from the readout first (I-R51); in a split
      // the 3D pane's own foot, the readout giving way while it shows (the other pane's foot is
      // another view's: the map's scale and credits)
      { id: 'volHint', want: volHint ? hintCorners(o.cursor, o.splitting) : [] },
      // --- RF coverage legend (rf-ui) ---
      { id: 'rfLegend', want: o.rfLegend ? (o.cursor === 'bl' ? ['br', 'bl'] : ['bl', 'br']) : [] },
      // --- end RF coverage legend ---
      { id: 'dates', want: dates ? ['tl', 'bl', 'tr'] : [] },
      { id: 'cursor', want: o.cursor ? [o.cursor] : [] },
    ];
    return assignSlots(items);
  }, [
    o.video,
    o.cursor,
    o.splitting,
    show,
    status,
    basemap,
    basemapAt,
    prepShown,
    volHint,
    stageHint,
    dates,
    topTaken,
    // --- RF coverage legend (rf-ui) ---
    o.rfLegend,
    // --- end RF coverage legend ---
  ]);
  // the callouts keep out of the overlays: placed again as the overlays move (they read their
  // keep-out on a rendered frame)
  const engine = o.engine;
  useEffect(() => {
    engine?.requestRender();
  }, [engine, slots]);
  const at = (id: string, node: ReactNode) => {
    const corner = slots.get(id);
    if (!corner || corner === 'hidden') return null;
    return (
      <div className="stage-slot" data-slot={corner} data-surface="dark">
        {node}
      </div>
    );
  };
  return {
    // (the volumes hint in its corner leaves a readout that stands clear of it shown)
    cursorHidden:
      o.cursor !== null &&
      slots.get('cursor') === 'hidden' &&
      !(o.readoutClear && slots.get('volHint') === o.cursor),
    // nothing in the other bottom corner: the readout need not keep to its half (beside the
    // hint in its own corner it does)
    cursorWide:
      !(o.readoutClear && slots.get('volHint') === o.cursor) &&
      ![...slots.values()].includes(o.cursor === 'bl' ? 'br' : 'bl'),
    corners: (
      <>
        {at('show', <StageShow />)}
        {at(
          'status',
          <div className="stage-under">
            {o.roadMeasure && <MeasureBar />}
            {cutaway && <StageStatus stage={o.engine} />}
            {notice && (
              <div className="stage-status" role="status">
                <span className="ss-chip compare-notice" data-testid="compare-notice">
                  <Icon name="warn" size={14} />
                  <span>{notice}</span>
                </span>
              </div>
            )}
          </div>,
        )}
        {basemap && at('basemap', <StageBasemapChip view={basemap} />)}
        {preparing && at('preparing', <PreparingCardView model={preparing} />)}
        {at('stageHint', <StageHint />)}
        {at('volHint', <VolumeHint />)}
        {/* // --- RF coverage legend (rf-ui) --- */}
        {at('rfLegend', <StageCoverageLegend />)}
        {/* // --- end RF coverage legend --- */}
        {at('dates', <DatesOnScreen kinds={DATE_KINDS} />)}
      </>
    ),
  };
}

/* ----------------------------------------------------------------------- stage */

/** A right-to-left UI (the corners are named by the reading direction). */
const rtlUi = () => typeof document !== 'undefined' && document.documentElement.dir === 'rtl';

/**
 * A 3D pane on the left of a split at least this wide keeps its readout clear of the volumes hint
 * at its foot: the hint takes up to 300 px from the corner (12 px in, @aio/volumetric), the
 * readout at most the pane's end half (styles.css .cursor-ro), with a gap between.
 */
const READOUT_PANE_MIN = 2 * (12 + 300 + 8);

/** Whether the 3D pane is at least READOUT_PANE_MIN wide; measured while `on`. */
function usePaneWide(panes: RefObject<HTMLDivElement | null>, on: boolean): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const pane = on ? panes.current?.querySelector('.pane-3d:not(.pane-compare)') : null;
    if (!pane || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      setWide(pane.getBoundingClientRect().width >= READOUT_PANE_MIN);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(pane);
    return () => {
      ro.disconnect();
    };
  }, [panes, on]);
  return wide;
}

/** Room kept below the open island for a top overlay: a chip and its gap. */
const TOP_SLOT_ROOM = 48;

type TopCorner = 'tl' | 'tr';
const TOP: readonly TopCorner[] = ['tl', 'tr'];

export interface IslandReach {
  /** The top corners the open island leaves clear: their overlays keep their place. */
  clear: readonly TopCorner[];
  /** The top corners it reaches across so far down that they are not free (topTaken). */
  taken: readonly TopCorner[];
}

const NO_REACH: IslandReach = { clear: [], taken: [] };
const sameCorners = (a: readonly TopCorner[], b: readonly TopCorner[]) =>
  a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * Which top corners the open island (its bottom edge is --isl-open-b on the stage, Island.tsx)
 * reaches across: a corner whose overlay lies beside the capsule and its T notice keeps its place
 * (`clear`); one under them moves below the island, and when that passes the middle of the
 * stage the corner is not free (`taken`) while it does, so its overlay does not come and go as
 * the corner empties. Also asks the stage to draw again as the island and its T notice
 * come, go and settle: the callouts read their keep-out on a rendered frame, so they move off
 * the notice then.
 */
function useIslandReach(
  stageRef: RefObject<HTMLDivElement | null>,
  engine: EngineStage | null,
): IslandReach {
  const [reach, setReach] = useState<IslandReach>(NO_REACH);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // taken while the open island reaches past the middle: the corner it empties is not
    // measured again (its overlay would come back, and go again)
    let held = new Set<TopCorner>();
    const read = () => {
      const bottom = Number.parseFloat(el.style.getPropertyValue('--isl-open-b')) || 0;
      if (bottom <= 0) {
        held = new Set();
        setReach((r) => (r.clear.length || r.taken.length ? NO_REACH : r));
        return;
      }
      const span = [
        el.querySelector(':scope > .island-wrap .island'),
        el.querySelector(':scope > .island-wrap > .isl-notice'),
      ]
        .map((e) => e?.getBoundingClientRect())
        .filter((r): r is DOMRect => r !== undefined && r.width > 0);
      const left = Math.min(...span.map((r) => r.left));
      const right = Math.max(...span.map((r) => r.right));
      const low = bottom + TOP_SLOT_ROOM > el.clientHeight / 2;
      if (!low) held = new Set();
      const clear: TopCorner[] = [];
      for (const c of TOP) {
        if (held.has(c)) continue;
        const slot = el.querySelector(`.stage-slot[data-slot='${c}']`)?.getBoundingClientRect();
        const under = slot !== undefined && slot.left < right && left < slot.right;
        if (!under) clear.push(c);
        else if (low) held.add(c);
      }
      const taken = TOP.filter((c) => held.has(c));
      setReach((r) =>
        sameCorners(r.clear, clear) && sameCorners(r.taken, taken) ? r : { clear, taken },
      );
    };
    const redraw = () => {
      engine?.requestRender();
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    // --isl-open-b is written on the stage's style
    const style = new MutationObserver(() => {
      read();
      redraw();
    });
    style.observe(el, { attributes: true, attributeFilter: ['style'] });
    // the T notice mounts under the island, and the island morphs in and out
    const wrap = el.querySelector(':scope > .island-wrap');
    const notice = new MutationObserver(redraw);
    if (wrap) notice.observe(wrap, { childList: true });
    const settled = () => {
      read();
      redraw();
    };
    el.addEventListener('transitionend', settled);
    el.addEventListener('animationend', settled);
    return () => {
      ro.disconnect();
      style.disconnect();
      notice.disconnect();
      el.removeEventListener('transitionend', settled);
      el.removeEventListener('animationend', settled);
    };
  }, [stageRef, engine]);
  return reach;
}

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
  // a walk compare the stage no longer shows ends: its walks keep to their own eyes again
  const walkComparing = useCompareFollowsStage(splitting ? sides : null);
  // Comparing dates: the 3D view and the map at most once per date, so maybe on both sides.
  const sides3d = splitting ? sidesOf(sides, '3d') : [];
  const sidesMap = splitting ? sidesOf(sides, 'map') : [];
  const show3d = mode === '3d' || sides3d.length > 0;
  const showMap = mode === 'map' || sidesMap.length > 0;
  // Once shown, the main map stays alive while the stage shows only 3D (hidden, like the 3D view
  // under the map): a new MapLibre map on every return cost a WebGL context and its shader
  // programs. Another project starts a new one.
  const [mapKeptFor, setMapKeptFor] = useState<string | null>(null);
  if (showMap && projectId !== null && mapKeptFor !== projectId) setMapKeptFor(projectId);
  const mountMap = showMap || (projectId !== null && mapKeptFor === projectId);
  const videoPane = splitting && sideOf(sides, 'video') !== undefined;
  const at = (kind: '3d' | 'map') => (kind === '3d' ? sides3d[0] : sidesMap[0]);
  const chooser = (kind: '3d' | 'map') => {
    const side = at(kind);
    return side ? <PaneHeader side={side} split={split} /> : null;
  };
  const showVideo = activeClip !== null && !videoHidden && !videoPane;
  // the corners the floating video takes as it rests, which the corner overlays keep out of (D30)
  const [videoCorners, setVideoCorners] = useState<readonly Corner[]>([]);
  const onVideoCorners = useCallback((c: readonly Corner[]) => {
    setVideoCorners((prev) => (prev.join() === c.join() ? prev : c));
  }, []);
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
  const keepOut = useCallback(() => {
    const root = stageRef.current;
    if (!root) return [];
    return [
      ...root.querySelectorAll(
        '.island, .isl-notice, .stage-rp, .stage-slot > *, .vwin:not(.docked), .cursor-ro, .stage-pop, .surface-pop, .elev-legend, .pane-head > *, .vol-legend, .sec-window',
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
  // the divider between the two sides (scene.split); the road's close-up dock keeps halves
  const divided = splitting && !closeup;
  const { containerRef: panesRef, handle: splitHandle } = useSplitDivider(divided);
  const roadMeasuring = useRoad((s) => Boolean(s.measure.mode));
  const islandReach = useIslandReach(stageRef, engine);
  // the 3D view on the left of a split has its readout beside the divider, clear of the hint
  // at the corner, unless its pane is narrow
  const pane3dWide = usePaneWide(panesRef, splitting && side3d === 'left');
  // the 3D view's readout is at the views' bottom end (the panes keep left-to-right geometry),
  // a stage corner unless the split shows the 3D view on the left
  const rtl = rtlUi();
  // the Map menu chip stands at the side of the pane it serves (the map's, else the 3D view's)
  const basemapAt = basemapCorners(showMap ? 'map' : 'scene', sideMap, side3d, splitting, rtl);
  // --- RF coverage legend (rf-ui) ---
  const rfLegend = useCoverageLegendShown();
  // --- end RF coverage legend ---
  const { cursorHidden, cursorWide, corners } = useStageCorners({
    engine,
    show3d,
    showMap,
    splitting,
    roadMeasure: roadMap !== null && showMap && roadMeasuring,
    video: showVideo && !docked ? videoCorners : NO_CORNERS,
    cursor: readoutCorner(show3d, splitting ? side3d : undefined, rtl),
    readoutClear: splitting && side3d === 'left' && pane3dWide,
    basemapAt,
    topTaken: islandReach.taken,
    // --- RF coverage legend (rf-ui) ---
    rfLegend,
    // --- end RF coverage legend ---
  });
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

  // Drone telemetry (the trace of the playing clip), per project, independent of the paths. Its
  // readings are the island's live line and the Video workbench, not a HUD on the model (D30).
  const telemetry = useTelemetryOn();
  const tr = useT();
  useEffect(() => {
    if (!engine) return;
    setDroneTelemetry(engine, { on: telemetry, labels: telemetryLabels(), hud: false });
  }, [engine, telemetry, tr]);

  // A photo picked from an issue's sightings opens in the Inspect photo viewer. A click on the
  // photo itself opens it in the split view first (photoOpen), and then stays on the scene.
  useEffect(
    () =>
      workspace.subscribe((s, prev) => {
        if (s.selection !== prev.selection && s.selection?.kind === 'photo' && !photoSplitIsOpen())
          shell.getState().go('inspect');
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
      className="stage"
      ref={stageRef}
      data-mode={mode}
      data-walk-compare={walkComparing ? 'on' : undefined}
      data-pop-bounds
      data-isl-clear={islandReach.clear.length ? islandReach.clear.join(' ') : undefined}
    >
      <VideoDock
        video={docked && showVideo && activeClip ? { layerId: activeClip, stageRef } : null}
      >
        {/* 3D and map panes keep their geometry in a right-to-left UI. */}
        <div
          ref={panesRef}
          className={`stage-panes${closeup ? ' with-dock' : ''}${divided ? ' split' : ''}`}
          data-mode={mode}
          dir="ltr"
        >
          <ScenePane
            hidden={!show3d}
            engine={engine}
            side={at('3d')}
            capture={sceneCapture}
            corner={chooser('3d')}
            cursorHidden={cursorHidden}
            cursorWide={cursorWide}
          />
          {second3d && secondCapture3d && index && (
            <CompareScene
              key={projectId}
              side={second3d}
              capture={secondCapture3d}
              index={index}
              main={engine}
              linked={linked}
              corner={<PaneHeader side={second3d} split={split} />}
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
              corner={<PaneHeader side={secondMap} split={split} />}
            />
          )}
          {mountMap && (
            <FocusZone
              kind="map"
              // hidden, it is not `.pane-map`: what looks for the map on screen does not find it
              className={
                showMap ? `pane pane-map${placingOnMap ? ' walk-placing' : ''}` : 'pane is-hidden'
              }
              data-side={at('map')}
              // off screen, its canvas and controls leave the tab order too
              inert={!showMap}
            >
              {showMap && <PlaceWalkHere at={MAP_SURFACE} />}
              <div className="fill">
                <MapView
                  className="scene-fill"
                  hidden={!showMap}
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
              {showMap && roadMap && <RoadLegend />}
              {showMap && <ChangeLegends />}
              {showMap && roadMap && <PciUnitCard />}
              {chooser('map')}
            </FocusZone>
          )}
          {splitting && <SplitPane side="left" split={split} />}
          {splitting && <SplitPane side="right" split={split} />}
          {splitHandle}
          {closeup && <CloseupDock />}
        </div>
        {corners}
      </VideoDock>
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
      {/* --- telecom antenna runner (telecom-ui) --- the inventory read, its boxes in 3D and the
          AI send preview, whatever the workbench shows */}
      <AntennaRunner />
      {/* --- end telecom antenna runner --- */}
      <SightingPicker kinds={['map']} />
      <SightingPicker kinds={['mesh', 'pointcloud']} />
      {!docked && showVideo && (
        <FloatingVideo
          layerId={activeClip}
          docked={false}
          stageRef={stageRef}
          onCorners={onVideoCorners}
        />
      )}
    </div>
  );
}
