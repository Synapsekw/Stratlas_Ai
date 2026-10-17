/**
 * The island's tool groups: the stage view switch, each group's quick row (a few tiles and inline
 * switches, D5) and, until the workbenches land, each group's full set as the stage toolbar had it.
 */
import { pinDisplay, usePinDisplay } from '@aio/annotate';
import type { EngineStage, LabelMode } from '@aio/engine';
import {
  Button,
  Icon,
  shortcutHint,
  useT,
  type IconName,
  type MessageKey,
  type ShortcutId,
} from '@aio/ui';
import { setCameraMode, videoRig, type CameraMode, type FlightPathMode } from '@aio/video';
import { useVolumetric, volumetric, type BodyMode, type SurfaceMode } from '@aio/volumetric';
import { useWorkspace, workspace } from '@aio/workspace';
import { useReducer, type ReactNode } from 'react';
import { openCleanupPanel } from '../../pointcloud/cleanupActions';
import { cleanup, useCleanup } from '../../pointcloud/cleanupStore';
import { RoadToolGroup, toggleMeasure as toggleRoadMeasure } from '../../road/RoadTools';
import { useIsRoad } from '../../road/useRoadMap';
import { setRoad, useRoad } from '../../road/store';
import { shell, useShell } from '../../shell';
import { openAgent } from '../../shell/RightHeader';
import type { StageMode } from '../../store';
import { MeasureToolbar } from '../../survey/MeasureToolbar';
import { startTool, stopTool, useMeasure } from '../../survey/measureStore';
import type { CompareDates } from '../CompareControls';
import { PATH_MODES, setPathMode } from '../flightPaths';
import { updateFlightPaths, useFlightPathModel } from '../pathModel';
import { surveyDateLabel } from '../surveyDateLabel';
import { siteBasemap, streetMapTool } from '../siteBasemap';
import { StreetMapTool } from '../StreetMapTool';
import { useStreetMap3d } from '../streetMap3d';
import { toggleTelemetry, useTelemetryOn } from '../telemetryPref';
import { toggleTimeline, useTimelineShown } from '../timelinePref';
import { insideView } from '../useCutaway';
import { AnnotateToggle } from '../tools/annotate';
import { CloudTools } from '../tools/cloud';
import { DisplayTools, LABEL_MODES } from '../tools/display';
import { MeasureTools, toggleMeasure, toggleSection } from '../tools/measure';
import { VideoTools } from '../tools/video';
import { ViewTools } from '../tools/view';
import { VolumeTools } from '../VolumeTools';
import type { GroupId } from './islandModel';

/** The stage views, keys 1, 2 and 3. */
export const MODES: { mode: StageMode; label: MessageKey; icon: IconName; keys: string }[] = [
  { mode: '3d', label: 'island.mode.3d', icon: 'scene', keys: '1' },
  { mode: 'map', label: 'island.mode.map', icon: 'map', keys: '2' },
  { mode: 'split', label: 'island.mode.split', icon: 'split', keys: '3' },
];

/** The group tabs' short names. */
export const GROUP_NAME: Record<GroupId, MessageKey> = {
  view: 'island.group.view',
  measure: 'island.group.measure',
  display: 'island.group.display',
  clouds: 'island.group.clouds',
  volumes: 'island.group.volumes',
  video: 'island.group.video',
  road: 'island.group.road',
  annotate: 'island.group.annotate',
};

export const GROUP_ICON: Record<GroupId, IconName> = {
  view: 'maximize',
  measure: 'ruler',
  display: 'layers',
  clouds: 'cloud',
  volumes: 'pile',
  video: 'video',
  road: 'road',
  annotate: 'anno',
};

/** The quick rows' names for the label and flight path modes (the full sets keep their own). */
const LABEL_NAME: Record<LabelMode, MessageKey> = {
  off: 'island.tile.labelOff',
  key: 'island.tile.labelKey',
  all: 'island.tile.labelAll',
};
const PATH_NAME: Record<FlightPathMode, MessageKey> = {
  all: 'island.tile.pathsAll',
  active: 'island.tile.pathsActive',
  off: 'island.tile.pathsOff',
};

export interface GroupCtx {
  stage: EngineStage | null;
  /** The tools work on the map only. */
  map: boolean;
  /** Open the group's full set (stage 1: a popover under the island). */
  openFull: (g: GroupId) => void;
  /** Compare dates, for the View tile. */
  compare: CompareDates;
}

/** A group's full set, as the stage toolbar showed it. */
export function fullGroup(g: GroupId, ctx: Pick<GroupCtx, 'stage' | 'map'>): ReactNode {
  const { stage, map } = ctx;
  switch (g) {
    case 'view':
      return <ViewTools stage={stage} map={map} />;
    case 'measure':
      // on the map only the survey measurements (the scene's own tools need the 3D view); the
      // site data (designs, survey QA, overlays, hydrology, haul road) are in the Survey
      // measurements popover
      return map ? <MeasureToolbar /> : <MeasureTools stage={stage} />;
    case 'display':
      return (
        <>
          <DisplayTools stage={stage} map={map} />
          {!map && <StreetMapTool />}
        </>
      );
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
}

/* ----------------------------------------------------------------------- tiles */

interface TileProps {
  icon: IconName;
  /** The short name under the icon. */
  label: string;
  /** The accessible name and tooltip, when longer than the label. */
  name?: string | undefined;
  shortcut?: ShortcutId | undefined;
  pressed?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Opens a panel (the corner caret). */
  caret?: boolean;
  /** Opens the group's full set: the accent tile at the end of a row. */
  toSide?: boolean;
  flip?: boolean;
  testId?: string;
  onClick: () => void;
}

/** A quick tile: icon, short name and key. */
export function Tile({
  icon,
  label,
  name,
  shortcut,
  pressed,
  disabled,
  caret,
  toSide,
  flip,
  testId,
  onClick,
}: TileProps) {
  // a single key in the corner; a combination ("Ctrl J") only in the tooltip
  const hint = shortcut ? shortcutHint(shortcut) : '';
  const corner = hint && !hint.includes(' ') ? hint : '';
  return (
    <Button
      variant="quiet"
      className={`isl-tile${toSide ? ' isl-to-side' : ''}`}
      aria-label={name ?? label}
      tip={name ?? label}
      data-testid={testId}
      onClick={onClick}
      {...(pressed !== undefined ? { pressed } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(shortcut ? { shortcut } : {})}
    >
      <Icon name={icon} size={20} {...(flip ? { className: 'flip' } : {})} />
      <span className="isl-tl">{label}</span>
      {corner && (
        <span className="isl-tk" aria-hidden="true">
          {corner}
        </span>
      )}
      {caret && <span className="caret" aria-hidden="true" />}
    </Button>
  );
}

interface ChoiceProps<V extends string> {
  label: string;
  shortcut?: ShortcutId;
  options: readonly { value: V; label: string; disabled?: boolean }[];
  value: V | null;
  disabled?: boolean;
  onPick: (v: V) => void;
}

/** An inline switch with its caption under it. */
export function Choice<V extends string>({
  label,
  shortcut,
  options,
  value,
  disabled,
  onPick,
}: ChoiceProps<V>) {
  return (
    <div className="isl-choice" role="group" aria-label={label}>
      <div className="seg">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            disabled={disabled === true || o.disabled === true}
            onClick={() => {
              onPick(o.value);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <span className="isl-cl" aria-hidden="true">
        {label}
        {shortcut && <span className="isl-tk">{shortcutHint(shortcut)}</span>}
      </span>
    </div>
  );
}

const Sep = () => <span className="isl-vsep" aria-hidden="true" />;

/** The tile that opens the group's full set (the right panel, from stage 2). */
function AllTools({ g, ctx }: { g: GroupId; ctx: GroupCtx }) {
  const t = useT();
  return (
    <>
      <Sep />
      <Tile
        icon="sidebar"
        flip
        caret
        toSide
        label={t('island.allTools')}
        name={t('island.groupTile', { group: t(GROUP_NAME[g]), tile: t('island.allTools') })}
        onClick={() => {
          ctx.openFull(g);
        }}
      />
    </>
  );
}

/* ----------------------------------------------------------------------- the quick rows */

const PRESETS: readonly { value: 'iso' | 'top' | 'north'; label: MessageKey }[] = [
  { value: 'iso', label: 'island.tile.presetIso' },
  { value: 'top', label: 'island.tile.presetTop' },
  { value: 'north', label: 'island.tile.presetNorth' },
];

function ViewRow({ ctx }: { ctx: GroupCtx }) {
  const t = useT();
  const { stage, map, compare } = ctx;
  const selection = useWorkspace((s) => s.selection);
  const activeClip = useWorkspace((s) => s.activeClip);
  const project = useWorkspace((s) => s.project);
  const timelineOn = useTimelineShown(project);
  // a road has the chainage ruler, not the timeline
  const road = useIsRoad();
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  return (
    <>
      <Tile
        icon="maximize"
        label={t('island.tile.wholeSite')}
        shortcut="scene.home"
        onClick={() => {
          workspace.getState().flyTo({ kind: 'home' });
        }}
      />
      <Tile
        icon="crosshair"
        label={t('island.tile.centre')}
        name={t('island.tile.centreName')}
        shortcut="scene.site"
        onClick={() => {
          workspace.getState().flyTo({ kind: 'site' });
        }}
      />
      <Tile
        icon="target"
        label={t('island.tile.flyTo')}
        name={t('island.tile.flyToName')}
        shortcut="scene.flySelection"
        disabled={!selection}
        onClick={() => {
          if (selection) workspace.getState().flyTo({ kind: 'selection', selection });
        }}
      />
      {!map && stage && (
        <Choice
          label={t('island.tile.viewPreset')}
          options={PRESETS.map((p) => ({ value: p.value, label: t(p.label) }))}
          value={null}
          onPick={(p) => {
            stage.setViewPreset(p);
          }}
        />
      )}
      {!map && stage && (
        <Tile
          icon="sun"
          label={t('island.tile.skyTime')}
          name={t('island.tile.skyTimeName')}
          caret
          onClick={() => {
            ctx.openFull('view');
          }}
        />
      )}
      {/* see inside the asset (I-R17): the inside view with a clip (C), else the Cutaway panel */}
      {!map && stage && (
        <Tile
          icon="cutaway"
          label={t('island.tile.seeInside')}
          name={activeClip ? t('stage.cutaway.insideView') : t('stage.cutaway.tool')}
          shortcut="scene.inside"
          caret={!activeClip}
          onClick={() => {
            if (activeClip) insideView(stage);
            else ctx.openFull('view');
          }}
        />
      )}
      {/* while comparing, Leave the comparison sits beside the island (one owner) */}
      {compare.available && !compare.twin && (
        <Tile
          icon="history"
          label={t('island.tile.compare')}
          name={compare.label}
          pressed={compare.twin}
          testId="compare-dates"
          onClick={() => {
            compare.open();
          }}
        />
      )}
      {!road && (
        <Tile
          icon="track"
          label={t('island.timeline')}
          name={timelineOn ? t('timeline.hide') : t('timeline.show')}
          pressed={timelineOn}
          disabled={!project}
          testId="timeline-toggle"
          onClick={() => {
            toggleTimeline(workspace.getState().project);
          }}
        />
      )}
      <Tile
        icon="agent"
        label={t('island.tile.askAgent')}
        name={t('island.askAgent')}
        shortcut="global.agent"
        onClick={openAgent}
      />
      <Sep />
      <Tile
        icon="sidebar"
        flip
        label={t('island.toRightPanel')}
        // the stage's own toggle at its top right keeps the Show / Hide names (one control each)
        name={t('island.toRightPanel')}
        shortcut="global.rightPanel"
        pressed={!rightCollapsed}
        onClick={shell.getState().toggleRight}
      />
    </>
  );
}

function MeasureRow({ ctx }: { ctx: GroupCtx }) {
  const t = useT();
  const { stage, map } = ctx;
  const active = useMeasure((s) => s.tool);
  const readOnly = useMeasure((s) => s.readOnly);
  const pkg = useShell((s) => s.pkg !== null);
  const survey = !readOnly && !pkg;
  const quick = stage?.tool === 'measure';
  const tool = (v: 'elevation' | 'area' | 'volume', icon: IconName, label: string) => (
    <Tile
      icon={icon}
      label={label}
      pressed={active?.tool === v && !active.template}
      onClick={() => {
        if (active?.tool === v && !active.template) stopTool();
        else startTool(v);
      }}
    />
  );
  return (
    <>
      {!map ? (
        <Tile
          icon="ruler"
          label={t('island.tile.distance')}
          name={t('island.tile.measureDistance')}
          shortcut="scene.measure"
          pressed={quick}
          disabled={!stage}
          onClick={() => {
            if (stage) toggleMeasure(stage);
          }}
        />
      ) : (
        survey && (
          <Tile
            icon="ruler"
            label={t('island.tile.distance')}
            pressed={active?.tool === 'distance' && !active.template}
            onClick={() => {
              if (active?.tool === 'distance' && !active.template) stopTool();
              else startTool('distance');
            }}
          />
        )
      )}
      {survey && tool('elevation', 'point', t('island.tile.elevation'))}
      {survey && tool('area', 'polygon', t('island.tile.area'))}
      {survey && tool('volume', 'pile', t('island.tile.volume'))}
      {!map && stage && (
        <Tile
          icon="section"
          label={t('island.tile.section')}
          name={t('island.tile.sectionPlane')}
          shortcut="scene.section"
          pressed={stage.section.enabled}
          onClick={() => {
            toggleSection(stage);
          }}
        />
      )}
      <AllTools g="measure" ctx={ctx} />
    </>
  );
}

function DisplayRow({ ctx }: { ctx: GroupCtx }) {
  const t = useT();
  const { stage, map } = ctx;
  const pins = usePinDisplay((s) => s.filter !== 'off');
  const labelMode = useShell((s) => s.labelMode);
  return (
    <>
      <Tile
        icon="pin"
        label={t('island.tile.issuePins')}
        name={pins ? t('stage.pins.hide') : t('stage.pins.show')}
        shortcut="scene.pins"
        pressed={pins}
        onClick={() => {
          pinDisplay.getState().togglePins();
        }}
      />
      {!map && (
        <Choice
          label={t('island.tile.labels')}
          shortcut="scene.labels"
          disabled={!stage}
          options={LABEL_MODES.map((m) => ({ value: m.mode, label: t(LABEL_NAME[m.mode]) }))}
          value={labelMode}
          onPick={(m) => {
            shell.getState().setLabelMode(m);
          }}
        />
      )}
      {!map && <StreetMapTile />}
      <AllTools g="display" ctx={ctx} />
    </>
  );
}

/** The street map under the site in 3D; greyed out, with the reason as its name, without a pack. */
function StreetMapTile() {
  const t = useT();
  const state = useStreetMap3d();
  const tool = streetMapTool(state);
  const { projectId, on } = state;
  if (!tool || !projectId) return null;
  return (
    <Tile
      icon="map"
      label={t('island.tile.streetMap')}
      name={t(tool.label)}
      pressed={tool.pressed}
      disabled={tool.disabled}
      testId="street-map-3d"
      onClick={() => {
        siteBasemap.getState().set(projectId, !on);
      }}
    />
  );
}

function CloudRow({ ctx }: { ctx: GroupCtx }) {
  const t = useT();
  const ids = useWorkspace((s) =>
    (s.project?.manifest.layers ?? [])
      .filter((l) => l.kind === 'pointcloud')
      .map((l) => l.id)
      .join('|'),
  );
  const shown = useWorkspace((s) => ids.split('|').some((id) => id && !s.hidden[id]));
  const cleanupOpen = useCleanup((s) => s.panelOpen);
  return (
    <>
      <Tile
        icon="cloud"
        label={t('island.tile.cloudShow')}
        name={t('island.tile.cloudShowName')}
        pressed={shown}
        onClick={() => {
          for (const id of ids.split('|')) workspace.getState().setLayerVisible(id, !shown);
        }}
      />
      <Tile
        icon="boxclip"
        label={t('island.tile.cleanUp')}
        name={t('cleanup.tool')}
        caret
        pressed={cleanupOpen}
        onClick={() => {
          if (cleanupOpen) cleanup.closePanel();
          else openCleanupPanel();
        }}
      />
      <AllTools g="clouds" ctx={ctx} />
    </>
  );
}

const SURFACES: readonly { value: SurfaceMode; label: MessageKey }[] = [
  { value: 'photo', label: 'island.tile.photo' },
  { value: 'elev', label: 'island.tile.elevation' },
  { value: 'change', label: 'island.tile.cutFill' },
];
const BODIES: readonly { value: BodyMode; label: MessageKey }[] = [
  { value: 'lift', label: 'island.tile.lifted' },
  { value: 'place', label: 'island.tile.inPlace' },
  { value: 'off', label: 'island.tile.hidden' },
];

function VolumeRow({ ctx }: { ctx: GroupCtx }) {
  const t = useT();
  const captures = useVolumetric((s) => s.file?.captures ?? []);
  const epoch = useVolumetric((s) => s.epoch);
  const swipe = useVolumetric((s) => s.swipe);
  const surface = useVolumetric((s) => s.surface);
  const body = useVolumetric((s) => s.body);
  const editing = useVolumetric((s) => s.edit !== null);
  const v = volumetric.getState();
  const SWIPE = '\u0000swipe';
  return (
    <>
      <Choice
        label={t('island.tile.surveyDate')}
        options={[
          ...captures.map((c) => ({ value: c.epoch, label: surveyDateLabel(c) })),
          { value: SWIPE, label: t('island.tile.swipe'), disabled: captures.length < 2 || editing },
        ]}
        value={swipe ? SWIPE : surface === 'change' ? null : epoch}
        onPick={(e) => {
          if (surface === 'change') v.setSurface('photo');
          if (e === SWIPE) {
            v.setSwipe(!swipe);
            return;
          }
          if (swipe) v.setSwipe(false);
          v.setEpoch(e);
        }}
      />
      <Choice
        label={t('island.tile.surface')}
        options={SURFACES.map((s) => ({
          value: s.value,
          label: t(s.label),
          disabled: s.value === 'change' && editing,
        }))}
        value={surface}
        onPick={(s) => {
          if (swipe) v.setSwipe(false);
          v.setSurface(s);
        }}
      />
      <Choice
        label={t('island.tile.bodies')}
        options={BODIES.map((b) => ({ value: b.value, label: t(b.label) }))}
        value={body}
        onPick={(b) => {
          v.setBody(b);
        }}
      />
      <AllTools g="volumes" ctx={ctx} />
    </>
  );
}

const CAMERA: readonly { value: CameraMode; label: MessageKey }[] = [
  { value: 'free', label: 'island.tile.free' },
  { value: 'follow', label: 'island.tile.follow' },
  { value: 'drone', label: 'island.tile.droneEye' },
];

function VideoRow({ ctx }: { ctx: GroupCtx }) {
  const t = useT();
  const { stage, map } = ctx;
  const activeClip = useWorkspace((s) => s.activeClip);
  const videoHidden = useShell((s) => s.videoHidden);
  const paths = useFlightPathModel();
  const telemetry = useTelemetryOn();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const showVideo = activeClip !== null && !videoHidden;
  const camera = stage && activeClip ? videoRig(stage).cameraMode : 'free';
  return (
    <>
      <Tile
        icon="video"
        label={t('island.tile.videoWindow')}
        name={showVideo ? t('island.tile.hideVideo') : t('island.tile.showVideo')}
        shortcut="scene.video"
        pressed={showVideo}
        disabled={activeClip === null}
        onClick={() => {
          shell.getState().setVideoHidden(!videoHidden);
        }}
      />
      {!map && paths && (
        <Choice
          label={t('island.tile.flightPaths')}
          shortcut="scene.flightPaths"
          options={PATH_MODES.map((p) => ({ value: p.mode, label: t(PATH_NAME[p.mode]) }))}
          value={paths.pref.mode}
          onPick={(m) => {
            updateFlightPaths((pref) => setPathMode(pref, m));
          }}
        />
      )}
      {!map && paths && (
        <Tile
          icon="telemetry"
          label={t('island.tile.telemetry')}
          name={telemetry ? t('stage.telemetry.hide') : t('stage.telemetry.show')}
          shortcut="scene.telemetry"
          pressed={telemetry}
          onClick={toggleTelemetry}
        />
      )}
      {!map && (
        <Choice
          label={t('island.tile.camera')}
          disabled={!stage}
          options={CAMERA.map((c) => ({
            value: c.value,
            label: t(c.label),
            disabled: c.value !== 'free' && activeClip === null,
          }))}
          value={camera}
          onPick={(m) => {
            if (!stage) return;
            setCameraMode(stage, m);
            bump();
          }}
        />
      )}
      <AllTools g="video" ctx={ctx} />
    </>
  );
}

function RoadRow({ ctx }: { ctx: GroupCtx }) {
  const t = useT();
  const overlay = useRoad((s) => s.overlay);
  const measuring = useRoad((s) => s.measure.mode !== null);
  const closeup = useRoad((s) => s.closeup);
  return (
    <>
      <Tile
        icon="photo"
        label={t('island.tile.closeup')}
        name={t('island.tile.closeupName')}
        shortcut="road.closeup"
        pressed={closeup}
        onClick={() => {
          setRoad({ closeup: !closeup });
        }}
      />
      <Tile
        icon="filter"
        label={t('island.tile.pci')}
        shortcut="road.pci"
        pressed={overlay === 'pci'}
        onClick={() => {
          setRoad({ overlay: overlay === 'pci' ? 'none' : 'pci' });
        }}
      />
      <Tile
        icon="raster"
        label={t('island.tile.density')}
        name={t('island.tile.densityName')}
        shortcut="road.density"
        pressed={overlay === 'density'}
        onClick={() => {
          setRoad({ overlay: overlay === 'density' ? 'none' : 'density' });
        }}
      />
      <Tile
        icon="ruler"
        label={t('island.tile.roadMeasure')}
        name={t('island.tile.roadMeasureName')}
        shortcut="road.measure"
        pressed={measuring}
        onClick={() => {
          toggleRoadMeasure();
        }}
      />
      <AllTools g="road" ctx={ctx} />
    </>
  );
}

function AnnotateRow({ ctx }: { ctx: GroupCtx }) {
  const t = useT();
  const on = useShell((s) => s.annotating);
  return (
    <>
      <Tile
        icon="anno"
        label={t('island.tile.annotate')}
        name={on ? t('island.tile.annotateClose') : t('island.tile.annotateOpen')}
        shortcut="scene.annotate"
        pressed={on}
        onClick={() => {
          shell.getState().setAnnotating(!on);
        }}
      />
      <AllTools g="annotate" ctx={ctx} />
    </>
  );
}

/**
 * A group's quick row (D5): a few tiles and switches, then the way to its full set.
 * TODO(stage 2, ruling I-R13): D5 items carried to the workbench tasks: the point cloud colour
 * switch RGB / Elevation / Intensity / Flight (Task 14), the Annotate tiles 3D pin, line, area,
 * cloud point, cloud box and map point, line, area (Task 15), Display's "Layers →" (Task 17).
 */
export function quickRow(g: GroupId, ctx: GroupCtx): ReactNode {
  switch (g) {
    case 'view':
      return <ViewRow ctx={ctx} />;
    case 'measure':
      return <MeasureRow ctx={ctx} />;
    case 'display':
      return <DisplayRow ctx={ctx} />;
    case 'clouds':
      return <CloudRow ctx={ctx} />;
    case 'volumes':
      return <VolumeRow ctx={ctx} />;
    case 'video':
      return <VideoRow ctx={ctx} />;
    case 'road':
      return <RoadRow ctx={ctx} />;
    case 'annotate':
      return <AnnotateRow ctx={ctx} />;
  }
}
