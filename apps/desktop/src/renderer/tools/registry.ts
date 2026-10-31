/**
 * The one tool registry (UI revision W8, design section 3). Every tool the workspace offers is
 * registered here once: its group, its name, its icon, its key, whether it can start here and
 * why not, and how it starts. The Tools tab, the island's modes and the command palette all read
 * it; none keeps a list of its own.
 *
 * Availability depends on the data the project holds and the view in use, never on the project
 * type or purpose (founder, 30 Oct 2026): a layout preset may reorder the groups, it never removes
 * one, and a tool that cannot start says why instead of vanishing.
 */
import { pinDisplay, usePinDisplay } from '@aio/annotate';
import type { EngineStage } from '@aio/engine';
import { isTelecomTool } from '@aio/survey';
import type { IconName, MessageKey, ShortcutId } from '@aio/ui';
import { volumetric, useVolumetric } from '@aio/volumetric';
import { workspace, useWorkspace } from '@aio/workspace';
import type { CompareDates } from '../workspace/CompareControls';
import { openCleanupPanel } from '../pointcloud/cleanupActions';
import { cleanup, useCleanup } from '../pointcloud/cleanupStore';
import { toggleMeasure as toggleRoadMeasure } from '../road/RoadTools';
import { roadStore, setRoad, useRoad } from '../road/store';
import { shell, useShell } from '../shell';
import { openAgent } from '../shell/RightHeader';
import type { StageMode } from '../store';
import { TOOL_ICON } from '../survey/card';
import {
  ALL_TOOLS,
  familyOf,
  measureFavourites,
  type CatalogueTool,
} from '../survey/measureCatalogue';
import { measureStore, startTool, stopTool, useMeasure } from '../survey/measureStore';
import { startTelecomTool } from '../survey/TelecomTools';
import { siteBasemap } from '../workspace/siteBasemap';
import { stagePrefs } from '../workspace/stagePrefs';
import { useStreetMap3d } from '../workspace/streetMap3d';
import { useDockClip } from '../workspace/video/videoDockStore';
import { telemetryOn, toggleTelemetry, useTelemetryOn } from '../workspace/telemetryPref';
import { toggleTimeline, useTimelineShown } from '../workspace/timelinePref';
import { toggleMeasure, toggleSection } from '../workspace/tools/measure';
import { toggleVolumeSection } from '../workspace/VolumeTools';
import {
  annotateStage,
  FORWARD as mapDraw,
  useAnnotateStage,
} from '../workspace/workbench/benches/annotateStage';
import { showBench, showSection } from '../workspace/workbench/followTool';
import {
  sectionDef,
  type PanelData,
  type PanelTab,
  type SectionId,
} from '../workspace/workbench/tabsModel';

// ---------------------------------------------------------------- groups

/** The tool groups, in the one order used everywhere (design D3). */
export const TOOL_GROUPS = [
  'view',
  'measure',
  'annotate',
  'volumes',
  'pointcloud',
  'terrain',
  'checks',
  'video',
  'road',
  'engineering',
  'coverage',
  'thermal',
  'environment',
] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export interface GroupDef {
  id: ToolGroup;
  labelKey: MessageKey;
  icon: IconName;
  /** Its section of the Tools tab. */
  section: SectionId;
}

export const GROUPS: Readonly<Record<ToolGroup, GroupDef>> = {
  view: { id: 'view', labelKey: 'wb.sec.view', icon: 'maximize', section: 'tools.view' },
  measure: { id: 'measure', labelKey: 'wb.sec.measure', icon: 'ruler', section: 'tools.measure' },
  annotate: {
    id: 'annotate',
    labelKey: 'wb.sec.annotate',
    icon: 'anno',
    section: 'tools.annotate',
  },
  volumes: { id: 'volumes', labelKey: 'wb.sec.volumes', icon: 'pile', section: 'tools.volumes' },
  pointcloud: {
    id: 'pointcloud',
    labelKey: 'wb.sec.pointcloud',
    icon: 'cloud',
    section: 'tools.pointcloud',
  },
  terrain: { id: 'terrain', labelKey: 'wb.sec.terrain', icon: 'raster', section: 'tools.terrain' },
  checks: { id: 'checks', labelKey: 'wb.sec.checks', icon: 'check', section: 'tools.checks' },
  video: { id: 'video', labelKey: 'wb.sec.video', icon: 'video', section: 'tools.video' },
  road: { id: 'road', labelKey: 'wb.sec.road', icon: 'road', section: 'tools.road' },
  engineering: {
    id: 'engineering',
    labelKey: 'wb.sec.engineering',
    icon: 'box',
    section: 'tools.engineering',
  },
  coverage: {
    id: 'coverage',
    labelKey: 'wb.sec.coverage',
    icon: 'target',
    section: 'tools.coverage',
  },
  thermal: { id: 'thermal', labelKey: 'wb.sec.thermal', icon: 'flare', section: 'tools.thermal' },
  environment: {
    id: 'environment',
    labelKey: 'wb.sec.environment',
    icon: 'sun',
    section: 'tools.environment',
  },
};

// ---------------------------------------------------------------- the context

/**
 * What a tool's availability reads: the data the project holds and the view in use. There is no
 * project type or purpose in it, on purpose. `stage` and `compare` are what `start` acts on.
 */
export interface ToolCtx {
  data: PanelData;
  /** The stage view. */
  mode: StageMode;
  /** The panes the tools work on: `map` when the map is all there is. */
  tools: StageMode;
  /** A 3D view is on the stage. */
  stage3d: boolean;
  /** The active space has a map: false only for a space with its own (`{ local }`) frame. */
  mapAvailable: boolean;
  /** A project package: nothing is written. */
  pkg: boolean;
  /** Read only (a package or a read-only project): the tools that save are off. */
  readOnly: boolean;
  /** Something is selected. */
  selection: boolean;
  /** A video clip to show: the active one, else the project's first (the video dock's, W9). */
  clip: boolean;
  /** The stockpile kit is loaded, with this many survey dates. */
  kit: boolean;
  kitDates: number;
  /** A street map is offered under the site in 3D: true, or why not. */
  streetMap: true | { reason: MessageKey } | null;
  /** The measurements are loaded (the telecom picks need them). */
  measuresReady: boolean;
  /** The stage's comparison of dates, where one is on the stage. */
  compare: CompareDates | null;
  stage: EngineStage | null;
}

export const NO_DATA: PanelData = {
  pointcloud: false,
  model3d: false,
  surface: false,
  video: false,
  photos: false,
  dated: false,
  volumes: false,
  road: false,
  flightlines: false,
};

export const EMPTY_CTX: ToolCtx = {
  data: NO_DATA,
  mode: '3d',
  tools: '3d',
  stage3d: false,
  mapAvailable: true,
  pkg: false,
  readOnly: false,
  selection: false,
  clip: false,
  kit: false,
  kitDates: 0,
  streetMap: null,
  measuresReady: true,
  compare: null,
  stage: null,
};

export type Availability = true | { reason: MessageKey };

// ---------------------------------------------------------------- tools

export interface ToolDef {
  id: string;
  group: ToolGroup;
  /** The short name (a tile's caption, a row's name). */
  labelKey: MessageKey;
  /** The full name, where the short one needs it (a tile's tooltip and accessible name). */
  nameKey?: MessageKey;
  /** The full name while it is on, for a tool that stays on ("Hide the timeline"). */
  nameOnKey?: MessageKey;
  /** A one-line hint under the name in the Tools tab. */
  hintKey?: MessageKey;
  icon: IconName;
  shortcutId?: ShortcutId;
  /** Extra words the palette finds it by. */
  keywords?: readonly MessageKey[];
  /** The test id the island's tile carries (the e2e specs know some by it). */
  testId?: string;
  /** The tool writes something: off in a read-only package. */
  saves?: boolean;
  /** Starting it opens its panel in the right sidebar (the island goes back to rest). */
  opens?: true;
  available: (ctx: ToolCtx) => Availability;
  start: (ctx: ToolCtx) => void;
  /** Turns it off again, for a tool that stays on (a tile pressed twice). */
  stop?: (ctx: ToolCtx) => void;
  /** Whether it is on now, for a tool that stays on (React: re-renders when it changes). */
  useOn?: (ctx: ToolCtx) => boolean;
}

const OK: Availability = true;
const needs = (ok: boolean, reason: MessageKey): Availability => (ok ? OK : { reason });

/** The order the checks run in: the first that fails says why. */
const all = (...checks: Availability[]): Availability => checks.find((c) => c !== true) ?? OK;

const in3d = (c: ToolCtx) => needs(c.stage3d && c.tools !== 'map', 'palette.unavailable.needs3d');
const onMap = (c: ToolCtx) => needs(c.mode !== '3d', 'toolReg.reason.needsMap');
const writable = (c: ToolCtx) => needs(!c.readOnly, 'palette.unavailable.readOnly');
const notPkg = (c: ToolCtx) => needs(!c.pkg, 'toolReg.reason.package');

const onScene = (fn: () => void) => () => {
  shell.getState().go('scene');
  fn();
};

// --- Measure: the catalogue's tools (survey/measureCatalogue.ts keeps their families)

/** Whether a catalogue tool is the live one now. */
const measureOn = (tool: CatalogueTool, stage: EngineStage | null): boolean => {
  if (tool === 'section-plane') return stage?.section.enabled === true;
  const active = measureStore.getState().tool;
  return active?.tool === tool && !active.template;
};

function startMeasure(tool: CatalogueTool, stage: EngineStage | null): void {
  shell.getState().go('scene');
  if (tool === 'section-plane') {
    measureFavourites.getState().used(tool);
    if (stage && !stage.section.enabled) toggleSection(stage);
    return;
  }
  if (measureOn(tool, stage)) return;
  if (tool === 'distance') toggleMeasure(stage);
  else if (isTelecomTool(tool)) startTelecomTool(tool);
  else {
    if (stage && stage.tool !== 'select') stage.setTool('select');
    startTool(tool);
  }
}

function telecomAvailable(c: ToolCtx): Availability {
  return c.readOnly
    ? { reason: 'palette.unavailable.telecomReadOnly' }
    : c.mode === 'map'
      ? { reason: 'palette.unavailable.telecomMap' }
      : !c.stage3d
        ? { reason: 'palette.unavailable.telecomNo3d' }
        : !c.measuresReady
          ? { reason: 'palette.unavailable.telecomLoading' }
          : OK;
}

/** The id a catalogue tool is registered under. */
export const measureToolId = (tool: CatalogueTool): string => `measure.${tool}`;

const MEASURE_TOOLS: readonly ToolDef[] = ALL_TOOLS.map((e) => ({
  id: measureToolId(e.tool),
  group: 'measure',
  labelKey: e.labelKey,
  hintKey: e.hintKey,
  icon: e.tool === 'section-plane' ? 'section' : TOOL_ICON[e.tool],
  ...(e.key ? { shortcutId: e.key } : {}),
  keywords: [e.hintKey, `measureCat.family.${familyOf(e.tool) ?? 'line'}`],
  saves: e.saves,
  available: (c) =>
    e.tool === 'section-plane'
      ? in3d(c)
      : isTelecomTool(e.tool)
        ? telecomAvailable(c)
        : e.saves
          ? writable(c)
          : OK,
  start: (c) => {
    startMeasure(e.tool, c.stage);
  },
  stop: (c) => {
    if (e.tool === 'section-plane') {
      if (c.stage?.section.enabled) toggleSection(c.stage);
    } else if (measureOn(e.tool, c.stage)) stopTool();
  },
  useOn: (c) => {
    const live = useMeasure((s) => s.tool?.tool === e.tool && !s.tool.template);
    return e.tool === 'section-plane' ? c.stage?.section.enabled === true : live;
  },
}));

// --- View

const VIEW_TOOLS: readonly ToolDef[] = [
  {
    id: 'view.wholeSite',
    group: 'view',
    labelKey: 'island.tile.wholeSite',
    icon: 'maximize',
    shortcutId: 'scene.home',
    available: () => OK,
    start: onScene(() => {
      workspace.getState().flyTo({ kind: 'home' });
    }),
  },
  {
    id: 'view.centre',
    group: 'view',
    labelKey: 'island.tile.centre',
    nameKey: 'island.tile.centreName',
    icon: 'crosshair',
    shortcutId: 'scene.site',
    available: () => OK,
    start: onScene(() => {
      workspace.getState().flyTo({ kind: 'site' });
    }),
  },
  {
    id: 'view.flyTo',
    group: 'view',
    labelKey: 'island.tile.flyTo',
    nameKey: 'island.tile.flyToName',
    icon: 'target',
    shortcutId: 'scene.flySelection',
    available: (c) => needs(c.selection, 'toolReg.reason.needsSelection'),
    start: onScene(() => {
      const selection = workspace.getState().selection;
      if (selection) workspace.getState().flyTo({ kind: 'selection', selection });
    }),
  },
  {
    id: 'view.skyTime',
    opens: true,
    group: 'view',
    labelKey: 'island.tile.skyTime',
    nameKey: 'island.tile.skyTimeName',
    icon: 'sun',
    available: in3d,
    start: () => {
      showBench('environment');
    },
  },
  {
    id: 'view.seeInside',
    opens: true,
    group: 'view',
    labelKey: 'island.tile.seeInside',
    nameKey: 'stage.cutaway.tool',
    icon: 'cutaway',
    available: (c) => all(in3d(c), needs(c.data.model3d, 'toolReg.reason.needsModel')),
    start: () => {
      showBench('cutaway');
    },
  },
  {
    id: 'view.compare',
    group: 'view',
    labelKey: 'island.tile.compare',
    nameKey: 'stage.compare.button',
    icon: 'history',
    testId: 'compare-dates',
    available: (c) =>
      all(
        // the stage's own comparison decides (the island publishes it)
        needs(c.compare !== null, 'toolReg.reason.needsStage'),
        needs(c.compare?.available === true, 'toolReg.reason.needsDates'),
        needs(c.compare?.twin !== true, 'toolReg.reason.comparing'),
      ),
    start: (c) => {
      shell.getState().go('scene');
      c.compare?.open();
    },
  },
  {
    id: 'view.timeline',
    group: 'view',
    labelKey: 'island.timeline',
    nameKey: 'timeline.show',
    nameOnKey: 'timeline.hide',
    icon: 'track',
    testId: 'timeline-toggle',
    // a road has the chainage ruler, not the timeline
    available: (c) =>
      all(
        needs(!c.data.road, 'toolReg.reason.road'),
        needs(c.data.video || c.data.dated, 'timeline.needsDates'),
      ),
    start: () => {
      toggleTimeline(workspace.getState().project);
    },
    stop: () => {
      toggleTimeline(workspace.getState().project);
    },
    useOn: () => useTimelineShown(useWorkspace((s) => s.project)),
  },
  {
    id: 'view.issuePins',
    group: 'view',
    labelKey: 'island.tile.issuePins',
    nameKey: 'stage.pins.show',
    nameOnKey: 'stage.pins.hide',
    icon: 'pin',
    shortcutId: 'scene.pins',
    available: () => OK,
    start: () => {
      if (pinDisplay.getState().filter === 'off') pinDisplay.getState().togglePins();
    },
    stop: () => {
      if (pinDisplay.getState().filter !== 'off') pinDisplay.getState().togglePins();
    },
    useOn: () => usePinDisplay((s) => s.filter !== 'off'),
  },
  {
    id: 'view.streetMap',
    group: 'view',
    labelKey: 'island.tile.streetMap',
    nameKey: 'stage.streetMap.show',
    nameOnKey: 'stage.streetMap.hide',
    icon: 'map',
    testId: 'street-map-3d',
    available: (c) => all(in3d(c), c.streetMap ?? { reason: 'toolReg.reason.streetMap' }),
    start: () => {
      const id = workspace.getState().project?.id;
      if (id) siteBasemap.getState().set(id, true);
    },
    stop: () => {
      const id = workspace.getState().project?.id;
      if (id) siteBasemap.getState().set(id, false);
    },
    useOn: () => useStreetMap3d().on,
  },
  {
    id: 'view.askAi',
    group: 'view',
    labelKey: 'island.tile.askAgent',
    nameKey: 'island.askAgent',
    icon: 'agent',
    shortcutId: 'global.agent',
    available: () => OK,
    start: () => {
      openAgent();
    },
  },
];

// --- Annotate

const ANNOTATE_3D = [
  ['point', 'pin', 'island.tile.annoPin', 'island.tile.annoPinName'],
  ['polyline', 'path', 'island.tile.annoLine', 'island.tile.annoLineName'],
  ['polygon', 'polygon', 'island.tile.annoArea', 'island.tile.annoAreaName'],
  ['cloud-point', 'crosshair', 'island.tile.annoCloudPoint', 'island.tile.annoCloudPointName'],
  ['cloud-box', 'boxclip', 'island.tile.annoCloudBox', 'island.tile.annoCloudBoxName'],
] as const;

const ANNOTATE_MAP = [
  ['point', 'point', 'island.tile.annoMapPoint', 'island.tile.annoMapPointName'],
  ['line', 'path', 'island.tile.annoMapLine', 'island.tile.annoMapLineName'],
  ['polygon', 'polygon', 'island.tile.annoMapArea', 'island.tile.annoMapAreaName'],
] as const;

const beginAnnotating = () => {
  shell.getState().go('scene');
  if (!shell.getState().annotating) shell.getState().setAnnotating(true);
};

const ANNOTATE_TOOLS: readonly ToolDef[] = [
  {
    id: 'annotate.open',
    group: 'annotate',
    labelKey: 'island.tile.annotate',
    nameKey: 'island.tile.annotateOpen',
    nameOnKey: 'island.tile.annotateClose',
    icon: 'anno',
    shortcutId: 'scene.annotate',
    saves: true,
    available: notPkg,
    start: beginAnnotating,
    stop: () => {
      shell.getState().setAnnotating(false);
    },
    useOn: () => useShell((s) => s.annotating),
  },
  ...ANNOTATE_3D.map(([tool, icon, labelKey, nameKey]): ToolDef => ({
    id: `annotate.${tool}`,
    group: 'annotate',
    labelKey,
    nameKey,
    icon,
    saves: true,
    available: (c) =>
      all(
        notPkg(c),
        in3d(c),
        tool.startsWith('cloud')
          ? needs(c.data.pointcloud, 'toolReg.reason.needsPointcloud')
          : needs(c.data.model3d, 'toolReg.reason.needsModel'),
      ),
    start: () => {
      beginAnnotating();
      annotateStage.getState().setTool(tool);
    },
    stop: () => {
      annotateStage.getState().setTool(null);
    },
    useOn: () => {
      const on = useShell((s) => s.annotating);
      return useAnnotateStage((s) => s.tool === tool) && on;
    },
  })),
  ...ANNOTATE_MAP.map(([mode, icon, labelKey, nameKey]): ToolDef => ({
    id: `annotate.map.${mode}`,
    group: 'annotate',
    labelKey,
    nameKey,
    icon,
    saves: true,
    available: (c) => all(notPkg(c), onMap(c)),
    start: () => {
      beginAnnotating();
      mapDraw.setMode(mode);
    },
    stop: () => {
      mapDraw.setMode(null);
    },
    useOn: () => {
      const on = useShell((s) => s.annotating);
      return useAnnotateStage((s) => s.mode === mode) && on;
    },
  })),
];

// --- Volumes

const VOLUME_TOOLS: readonly ToolDef[] = [
  {
    id: 'volumes.table',
    opens: true,
    group: 'volumes',
    labelKey: 'toolReg.volumesTable',
    nameKey: 'toolReg.volumesTableName',
    icon: 'pile',
    available: (c) => needs(c.data.volumes, 'toolReg.reason.needsPiles'),
    start: () => {
      showBench('volumes');
    },
  },
  {
    id: 'volumes.swipe',
    group: 'volumes',
    labelKey: 'vol.swipe',
    nameKey: 'vol.swipeBetween',
    icon: 'split',
    available: (c) => all(needs(c.kit && c.kitDates >= 2, 'toolReg.reason.needsKit'), in3d(c)),
    start: () => {
      const v = volumetric.getState();
      // a swipe shows the two surveys' photos
      if (v.surface === 'change') v.setSurface('photo');
      if (!v.swipe) v.setSwipe(true);
    },
    stop: () => {
      volumetric.getState().setSwipe(false);
    },
    useOn: () => useVolumetric((s) => s.swipe),
  },
  {
    id: 'volumes.section',
    group: 'volumes',
    labelKey: 'island.tile.section',
    nameKey: 'vol.sectionLine',
    icon: 'section',
    available: (c) => all(needs(c.kit, 'toolReg.reason.needsKit'), in3d(c)),
    start: () => {
      if (volumetric.getState().section.mode === 'idle') toggleVolumeSection();
    },
    stop: () => {
      if (volumetric.getState().section.mode !== 'idle') toggleVolumeSection();
    },
    useOn: () => useVolumetric((s) => s.section.mode !== 'idle'),
  },
];

// --- Point cloud

const pointcloudIds = () =>
  (workspace.getState().project?.manifest.layers ?? [])
    .filter((l) => l.kind === 'pointcloud')
    .map((l) => l.id);

const POINTCLOUD_TOOLS: readonly ToolDef[] = [
  {
    id: 'pointcloud.show',
    group: 'pointcloud',
    labelKey: 'island.tile.cloudShow',
    nameKey: 'island.tile.cloudShowName',
    icon: 'cloud',
    available: (c) => needs(c.data.pointcloud, 'toolReg.reason.needsPointcloud'),
    start: () => {
      for (const id of pointcloudIds()) workspace.getState().setLayerVisible(id, true);
    },
    stop: () => {
      for (const id of pointcloudIds()) workspace.getState().setLayerVisible(id, false);
    },
    useOn: () =>
      useWorkspace((s) =>
        (s.project?.manifest.layers ?? []).some((l) => l.kind === 'pointcloud' && !s.hidden[l.id]),
      ),
  },
  {
    id: 'pointcloud.cleanUp',
    opens: true,
    group: 'pointcloud',
    labelKey: 'island.tile.cleanUp',
    nameKey: 'cleanup.tool',
    icon: 'boxclip',
    saves: true,
    available: (c) => all(needs(c.data.pointcloud, 'toolReg.reason.needsPointcloud'), notPkg(c)),
    start: () => {
      if (!cleanup.store.getState().panelOpen) openCleanupPanel();
    },
    stop: () => {
      cleanup.closePanel();
    },
    useOn: () => useCleanup((s) => s.panelOpen),
  },
];

// --- Video

const VIDEO_TOOLS: readonly ToolDef[] = [
  {
    id: 'video.window',
    group: 'video',
    labelKey: 'island.tile.videoWindow',
    nameKey: 'island.tile.showVideo',
    nameOnKey: 'island.tile.hideVideo',
    icon: 'video',
    shortcutId: 'scene.video',
    available: (c) =>
      all(
        needs(c.data.video, 'toolReg.reason.needsVideo'),
        needs(c.clip, 'toolReg.reason.needsClip'),
      ),
    start: () => {
      shell.getState().setVideoHidden(false);
    },
    stop: () => {
      shell.getState().setVideoHidden(true);
    },
    useOn: () => {
      const clip = useDockClip() !== null;
      return useShell((s) => !s.videoHidden) && clip;
    },
  },
  {
    id: 'video.telemetry',
    group: 'video',
    labelKey: 'island.tile.telemetry',
    nameKey: 'stage.telemetry.show',
    nameOnKey: 'stage.telemetry.hide',
    icon: 'telemetry',
    shortcutId: 'scene.telemetry',
    available: (c) => all(needs(c.data.video, 'toolReg.reason.needsVideo'), in3d(c)),
    start: () => {
      if (!telemetryOnNow()) toggleTelemetry();
    },
    stop: () => {
      if (telemetryOnNow()) toggleTelemetry();
    },
    useOn: () => useTelemetryOn(),
  },
];

/** The telemetry overlay is on for the open project now (a toggle: read before flipping). */
const telemetryOnNow = (): boolean =>
  telemetryOn(stagePrefs.getState(), workspace.getState().project?.id ?? null);

// --- Road

const ROAD_TOOLS: readonly ToolDef[] = [
  {
    id: 'road.closeup',
    group: 'road',
    labelKey: 'island.tile.closeup',
    nameKey: 'island.tile.closeupName',
    icon: 'photo',
    shortcutId: 'road.closeup',
    available: (c) => needs(c.data.road, 'toolReg.reason.needsRoad'),
    start: () => {
      setRoad({ closeup: true });
    },
    stop: () => {
      setRoad({ closeup: false });
    },
    useOn: () => useRoad((s) => s.closeup),
  },
  {
    id: 'road.pci',
    group: 'road',
    labelKey: 'island.tile.pci',
    icon: 'filter',
    shortcutId: 'road.pci',
    available: (c) => needs(c.data.road, 'toolReg.reason.needsRoad'),
    start: () => {
      setRoad({ overlay: 'pci' });
    },
    stop: () => {
      setRoad({ overlay: 'none' });
    },
    useOn: () => useRoad((s) => s.overlay === 'pci'),
  },
  {
    id: 'road.density',
    group: 'road',
    labelKey: 'island.tile.density',
    nameKey: 'island.tile.densityName',
    icon: 'raster',
    shortcutId: 'road.density',
    available: (c) => needs(c.data.road, 'toolReg.reason.needsRoad'),
    start: () => {
      setRoad({ overlay: 'density' });
    },
    stop: () => {
      setRoad({ overlay: 'none' });
    },
    useOn: () => useRoad((s) => s.overlay === 'density'),
  },
  {
    id: 'road.measure',
    group: 'road',
    labelKey: 'island.tile.roadMeasure',
    nameKey: 'island.tile.roadMeasureName',
    icon: 'ruler',
    shortcutId: 'road.measure',
    available: (c) => all(needs(c.data.road, 'toolReg.reason.needsRoad'), onMap(c)),
    start: () => {
      if (roadStore.getState().measure.mode === null) toggleRoadMeasure();
    },
    stop: () => {
      if (roadStore.getState().measure.mode !== null) toggleRoadMeasure();
    },
    useOn: () => useRoad((s) => s.measure.mode !== null),
  },
];

/** Every tool, each once, in group order then each group's own order. */
export const TOOLS: readonly ToolDef[] = [
  ...VIEW_TOOLS,
  ...MEASURE_TOOLS,
  ...ANNOTATE_TOOLS,
  ...VOLUME_TOOLS,
  ...POINTCLOUD_TOOLS,
  ...VIDEO_TOOLS,
  ...ROAD_TOOLS,
];

export const toolById = (id: string): ToolDef | undefined => TOOLS.find((d) => d.id === id);

// ---------------------------------------------------------------- what is offered

/**
 * When a group's section shows in the Tools tab: the data its tools work on is there (a group
 * whose tools could start nowhere in this project). Never the project type.
 */
const GROUP_NEEDS: Partial<Record<ToolGroup, (d: PanelData) => boolean>> = {
  volumes: (d) => d.volumes,
  pointcloud: (d) => d.pointcloud,
  terrain: (d) => d.surface,
  checks: (d) => d.surface,
  video: (d) => d.video,
  road: (d) => d.road,
  engineering: (d) => d.model3d,
  coverage: (d) => d.model3d,
  thermal: (d) => d.photos,
};

export const groupShown = (g: ToolGroup, data: PanelData): boolean =>
  GROUP_NEEDS[g]?.(data) ?? true;

/**
 * The groups to offer, each with its tools, in registry order, or `order` first and then the rest
 * in registry order (a preset leads with some groups, it never removes one). A group shows when
 * the project holds its data.
 */
export function toolsFor(
  ctx: ToolCtx,
  order: readonly ToolGroup[] = [],
): { group: ToolGroup; tools: ToolDef[] }[] {
  const lead = order.filter((g, i) => TOOL_GROUPS.includes(g) && order.indexOf(g) === i);
  const groups = [...lead, ...TOOL_GROUPS.filter((g) => !lead.includes(g))];
  return groups
    .filter((g) => groupShown(g, ctx.data))
    .map((group) => ({ group, tools: TOOLS.filter((d) => d.group === group) }));
}

/** The tool's full name key as it reads now (on or off). */
export const nameKeyOf = (def: ToolDef, on: boolean): MessageKey =>
  (on ? def.nameOnKey : undefined) ?? def.nameKey ?? def.labelKey;

/** Whether the tool can start here, the read-only package's rule included. */
export function availability(def: ToolDef, ctx: ToolCtx): Availability {
  if (def.saves && ctx.pkg) return { reason: 'palette.unavailable.readOnly' };
  return def.available(ctx);
}

// ---------------------------------------------------------------- the island's modes

export const ISLAND_MODES = [
  'view',
  'measure',
  'annotate',
  'volumes',
  'compare',
  'video',
  'road',
] as const;
export type IslandMode = (typeof ISLAND_MODES)[number];

export interface IslandModeDef {
  id: IslandMode;
  labelKey: MessageKey;
  icon: IconName;
  /** Where picking it takes the right panel. */
  tab: PanelTab;
  section: SectionId;
  /** Its tools, in order: a group's, or a list of its own (Compare's). */
  group: ToolGroup | null;
  tools?: readonly string[];
  /** Listed on the island for this project and view (Road only with a road, off the 3D view). */
  shows: (ctx: ToolCtx) => boolean;
  /**
   * Whether it can be picked, or why not (greyed out with the reason). Every mode can be picked
   * today; this is the one place a mode's own rule goes (a mode that needs the map, say).
   */
  available: (ctx: ToolCtx) => Availability;
}

export const MODE_DEFS: Readonly<Record<IslandMode, IslandModeDef>> = {
  view: {
    id: 'view',
    labelKey: 'island.group.view',
    icon: 'maximize',
    tab: 'tools',
    section: 'tools.view',
    group: 'view',
    // the dates' tools are Compare's
    tools: [
      'view.wholeSite',
      'view.centre',
      'view.flyTo',
      'view.skyTime',
      'view.seeInside',
      'view.issuePins',
      'view.streetMap',
      'view.askAi',
    ],
    shows: () => true,
    available: () => OK,
  },
  measure: {
    id: 'measure',
    labelKey: 'island.group.measure',
    icon: 'ruler',
    tab: 'tools',
    section: 'tools.measure',
    group: 'measure',
    shows: () => true,
    available: () => OK,
  },
  annotate: {
    id: 'annotate',
    labelKey: 'island.group.annotate',
    icon: 'anno',
    tab: 'tools',
    section: 'tools.annotate',
    group: 'annotate',
    shows: (c) => !c.pkg,
    available: () => OK,
  },
  volumes: {
    id: 'volumes',
    labelKey: 'island.group.volumes',
    icon: 'pile',
    tab: 'project',
    section: 'project.volumes',
    group: 'volumes',
    shows: (c) => c.data.volumes,
    available: () => OK,
  },
  compare: {
    id: 'compare',
    labelKey: 'island.group.compare',
    icon: 'history',
    tab: 'project',
    section: 'project.changes',
    group: null,
    tools: ['view.compare', 'view.timeline', 'volumes.swipe'],
    // a road compares by chainage, not by date (as before the registry)
    shows: (c) => !c.data.road && (c.data.dated || c.data.video),
    available: () => OK,
  },
  video: {
    id: 'video',
    labelKey: 'island.group.video',
    icon: 'video',
    tab: 'tools',
    section: 'tools.video',
    group: 'video',
    shows: (c) => c.data.video,
    available: () => OK,
  },
  road: {
    id: 'road',
    labelKey: 'island.group.road',
    icon: 'road',
    tab: 'project',
    section: 'project.road',
    group: 'road',
    shows: (c) => c.data.road && c.tools !== '3d',
    available: (c) => needs(c.mapAvailable, 'fly.map.local'),
  },
};

/** The stage view switch: Map and Split need a map, so a space without one greys them out. */
export function stageModeAvailable(mode: StageMode, ctx: ToolCtx): Availability {
  return mode === '3d' ? OK : needs(ctx.mapAvailable, 'fly.map.local');
}

/** The island's modes for this project and view, in their order. */
export function islandModes(ctx: ToolCtx): IslandModeDef[] {
  return ISLAND_MODES.map((m) => MODE_DEFS[m]).filter((m) => m.shows(ctx));
}

/** A mode's tools, in its own order. */
export function modeTools(mode: IslandMode): ToolDef[] {
  const def = MODE_DEFS[mode];
  if (def.tools) return def.tools.map(toolById).filter((d): d is ToolDef => d !== undefined);
  return TOOLS.filter((d) => d.group === def.group);
}

/** How many tools a mode's slim row shows. */
export const TOP_TOOLS = 5;

/**
 * A mode's top tools for the island's second row: the person's favourites, then the tools used
 * last (`preferred`, registry ids), then the mode's own order; those that can start here first,
 * at most `TOP_TOOLS`.
 */
export function topTools(
  mode: IslandMode,
  ctx: ToolCtx,
  preferred: readonly string[] = [],
  max = TOP_TOOLS,
): ToolDef[] {
  let own = modeTools(mode);
  // with the map on the stage (Map or Split) Annotate leads with the map's tools
  if (mode === 'annotate' && ctx.mode !== '3d')
    own = [
      ...own.filter((d) => d.id === 'annotate.open'),
      ...own.filter((d) => d.id.startsWith('annotate.map.')),
      ...own.filter((d) => d.id !== 'annotate.open' && !d.id.startsWith('annotate.map.')),
    ];
  const picked = [
    ...preferred.map((id) => own.find((d) => d.id === id)).filter((d): d is ToolDef => !!d),
    ...own,
  ].filter((d, i, list) => list.indexOf(d) === i);
  const ready = picked.filter((d) => availability(d, ctx) === true);
  const rest = picked.filter((d) => availability(d, ctx) !== true);
  return [...ready, ...rest].slice(0, max);
}

/** Open a mode's place in the right panel (its group's section, or Compare's changes). */
export function openMode(mode: IslandMode, ctx: ToolCtx): void {
  const def = MODE_DEFS[mode];
  // Compare's changes need two dates; without them its tools are the whole mode
  if (mode === 'compare' && !ctx.data.dated) return;
  // a section with an old tab's body brings that body forward (the live tool follows it)
  const body = sectionDef(def.section)?.body ?? null;
  if (body) showBench(body);
  // a section of the registry's tools alone: with the right panel folded the row is enough
  else if (!shell.getState().rightCollapsed) showSection(def.tab, def.section);
}

/** Start a tool from anywhere (a row, a tile, the palette): nothing when it cannot start here. */
export function runTool(def: ToolDef, ctx: ToolCtx): void {
  if (availability(def, ctx) !== true) return;
  def.start(ctx);
}
