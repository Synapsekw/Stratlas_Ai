/**
 * The layout spike's pure model (UI revision design D1, D2, D3, D7): the window bands, the four
 * right-panel tabs and their sections, the 20 tab ids of today mapped in, the tool groups and the
 * seven layout presets. No React, no DOM. W7, W12 and W13 build the real versions; this one only
 * has to be honest enough for the founder to approve or redirect the layout (gate G1).
 */
import {
  projectPurpose,
  type ProjectManifest,
  type ProjectPurpose,
  type ProjectType,
} from '@aio/schema';
import type { MessageKey } from '@aio/ui';
import type { TabId } from '../workspace/workbench/tabsModel';

// ---------------------------------------------------------------- bands (D1)

export type Band = 'wide' | 'mid' | 'narrow';

export interface BandSizes {
  /** How the Layers column shows by default: open in the grid, folded, or over the stage. */
  layers: 'open' | 'collapsed' | 'overlay';
  layersPx: number;
  rightPx: number;
  rightMin: number;
  rightMax: number;
  stripPx: number;
}

export const RAIL_PX = 52;
export const TITLE_PX = 40;
/** The strip folded to its scrubber. */
export const STRIP_FOLDED_PX = 32;

export const BANDS: Readonly<Record<Band, BandSizes>> = {
  wide: { layers: 'open', layersPx: 240, rightPx: 360, rightMin: 320, rightMax: 520, stripPx: 160 },
  mid: {
    layers: 'collapsed',
    layersPx: 240,
    rightPx: 320,
    rightMin: 300,
    rightMax: 480,
    stripPx: 140,
  },
  narrow: {
    layers: 'overlay',
    layersPx: 240,
    rightPx: 300,
    rightMin: 280,
    rightMax: 400,
    stripPx: 120,
  },
};

/** The band of a window width: >= 1440 wide, 1280 to 1440 mid, below 1280 narrow. */
export function bandOf(width: number): Band {
  if (width >= 1440) return 'wide';
  if (width >= 1280) return 'mid';
  return 'narrow';
}

/** A dragged width, kept inside the band's range. */
export function clampRight(band: Band, px: number): number {
  const b = BANDS[band];
  return Math.round(Math.min(b.rightMax, Math.max(b.rightMin, px)));
}

// ---------------------------------------------------------------- what the project holds (D7)

export interface ProjectData {
  video: boolean;
  walks: boolean;
  pointcloud: boolean;
  mesh: boolean;
  raster: boolean;
  photos: boolean;
  /** Two or more survey dates. */
  dates2: boolean;
  piles: boolean;
  road: boolean;
}

export const NO_DATA: ProjectData = {
  video: false,
  walks: false,
  pointcloud: false,
  mesh: false,
  raster: false,
  photos: false,
  dates2: false,
  piles: false,
  road: false,
};

/** What a project holds, from its manifest and what the stores know (piles, a road). */
export function projectData(
  manifest: Pick<ProjectManifest, 'layers' | 'captures'>,
  more: { piles: boolean; road: boolean },
): ProjectData {
  const kinds = new Set(manifest.layers.map((l) => l.kind));
  const dated = manifest.captures.filter((c) => Number.isFinite(Date.parse(c.date))).length;
  return {
    video: kinds.has('video'),
    walks: kinds.has('walk'),
    pointcloud: kinds.has('pointcloud'),
    mesh: kinds.has('mesh'),
    raster: kinds.has('raster'),
    photos: kinds.has('photos') || kinds.has('panoramas'),
    dates2: dated >= 2,
    piles: more.piles,
    road: more.road,
  };
}

const surface = (d: ProjectData) => d.pointcloud || d.mesh || d.raster;
const model3d = (d: ProjectData) => d.pointcloud || d.mesh;

// ---------------------------------------------------------------- tabs and sections (D2)

export type PanelTab = 'selection' | 'tools' | 'layers' | 'project';

export const PANEL_TABS: readonly PanelTab[] = ['selection', 'tools', 'layers', 'project'];

export const TAB_LABEL: Readonly<Record<PanelTab, MessageKey>> = {
  selection: 'layoutSpike.tab.selection',
  tools: 'layoutSpike.tab.tools',
  layers: 'layoutSpike.tab.layers',
  project: 'layoutSpike.tab.project',
};

export type ToolGroup =
  | 'view'
  | 'measure'
  | 'annotate'
  | 'volumes'
  | 'pointcloud'
  | 'terrain'
  | 'checks'
  | 'video'
  | 'road'
  | 'engineering'
  | 'coverage'
  | 'thermal'
  | 'environment';

/** One order everywhere (D3); a preset puts its groups first and keeps the rest. */
export const TOOL_GROUPS: readonly ToolGroup[] = [
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
];

export type ProjectSection = 'inThisProject' | 'volumes' | 'changes' | 'issues' | 'road' | 'jobs';
export type LayersSection = 'show' | 'display' | 'clouds' | 'overlays' | 'cutaway';

/** A section id: `<tab>.<name>`. */
export type SectionId =
  | 'selection.selected'
  | `tools.${ToolGroup}`
  | `layers.${LayersSection}`
  | `project.${ProjectSection}`;

export interface SectionDef {
  id: SectionId;
  tab: PanelTab;
  label: MessageKey;
  /** Today's workbench tab whose body the section shows (null: a spike body of its own). */
  body: TabId | null;
  /** Shown when the project holds this data; absent: always. Never the project type. */
  needs?: (d: ProjectData) => boolean;
}

const tool = (
  g: ToolGroup,
  body: TabId | null,
  needs?: (d: ProjectData) => boolean,
): SectionDef => ({
  id: `tools.${g}`,
  tab: 'tools',
  label: `layoutSpike.group.${g}`,
  body,
  ...(needs ? { needs } : {}),
});

export const SECTIONS: readonly SectionDef[] = [
  {
    id: 'selection.selected',
    tab: 'selection',
    label: 'layoutSpike.sec.selection',
    body: 'selection',
  },
  tool('view', null),
  tool('measure', 'measure'),
  tool('annotate', 'annotate'),
  tool('volumes', null, (d) => d.piles || surface(d)),
  tool('pointcloud', 'cleanup', (d) => d.pointcloud),
  tool('terrain', 'hydro', surface),
  tool('checks', 'qa', surface),
  tool('video', 'video', (d) => d.video),
  tool('road', 'road', (d) => d.road),
  tool('engineering', 'review', model3d),
  tool('coverage', 'rf', model3d),
  tool('thermal', 'thermal', (d) => d.photos),
  tool('environment', 'environment'),
  { id: 'layers.show', tab: 'layers', label: 'layoutSpike.sec.show', body: null },
  { id: 'layers.display', tab: 'layers', label: 'layoutSpike.sec.display', body: 'display' },
  {
    id: 'layers.clouds',
    tab: 'layers',
    label: 'layoutSpike.sec.clouds',
    body: 'clouds',
    needs: (d) => d.pointcloud,
  },
  {
    id: 'layers.overlays',
    tab: 'layers',
    label: 'layoutSpike.sec.overlays',
    body: 'overlays',
    needs: surface,
  },
  {
    id: 'layers.cutaway',
    tab: 'layers',
    label: 'layoutSpike.sec.cutaway',
    body: 'cutaway',
    needs: model3d,
  },
  {
    id: 'project.inThisProject',
    tab: 'project',
    label: 'layoutSpike.sec.inThisProject',
    body: null,
  },
  {
    id: 'project.volumes',
    tab: 'project',
    label: 'layoutSpike.sec.volumes',
    body: 'volumes',
    needs: (d) => d.piles,
  },
  {
    id: 'project.changes',
    tab: 'project',
    label: 'layoutSpike.sec.changes',
    body: 'changes',
    needs: (d) => d.dates2,
  },
  { id: 'project.issues', tab: 'project', label: 'layoutSpike.sec.issues', body: null },
  {
    id: 'project.road',
    tab: 'project',
    label: 'layoutSpike.sec.road',
    body: 'road',
    needs: (d) => d.road,
  },
  { id: 'project.jobs', tab: 'project', label: 'layoutSpike.sec.jobs', body: 'jobs' },
];

export function sectionDef(id: SectionId): SectionDef | undefined {
  return SECTIONS.find((s) => s.id === id);
}

/**
 * Where each of today's 20 workbench tab ids lives in the four tabs (the D2 table). Measure
 * splits: its "In this project" list goes to Project, its catalogue to Tools > Measure (the live
 * tool card stays the armed state of Tools); the old id leads to the catalogue, where a tool runs.
 */
export const OLD_TAB_HOME: Readonly<Record<TabId, SectionId>> = {
  selection: 'selection.selected',
  measure: 'tools.measure',
  annotate: 'tools.annotate',
  volumes: 'project.volumes',
  changes: 'project.changes',
  issues: 'project.issues',
  road: 'project.road',
  jobs: 'project.jobs',
  display: 'layers.display',
  clouds: 'layers.clouds',
  overlays: 'layers.overlays',
  cutaway: 'layers.cutaway',
  video: 'tools.video',
  qa: 'tools.checks',
  hydro: 'tools.terrain',
  cleanup: 'tools.pointcloud',
  review: 'tools.engineering',
  environment: 'tools.environment',
  rf: 'tools.coverage',
  thermal: 'tools.thermal',
};

export function sectionFor(old: TabId): { tab: PanelTab; section: SectionId } {
  const section = OLD_TAB_HOME[old];
  return { tab: sectionTab(section), section };
}

export function sectionTab(id: SectionId): PanelTab {
  return id.split('.')[0] as PanelTab;
}

/** The sections a tab shows for this data, in its order (a preset may lead with some of them). */
export function sectionsOf(
  tab: PanelTab,
  data: ProjectData,
  lead: readonly SectionId[] = [],
): SectionDef[] {
  const here = SECTIONS.filter((s) => s.tab === tab && (s.needs?.(data) ?? true));
  const first = lead
    .map((id) => here.find((s) => s.id === id))
    .filter((s): s is SectionDef => s !== undefined);
  return [...first, ...here.filter((s) => !first.includes(s))];
}

/** The tool groups that wait for data this project does not hold yet. */
export function waitingGroups(data: ProjectData): ToolGroup[] {
  return SECTIONS.filter((s) => s.tab === 'tools' && s.needs && !s.needs(data)).map(
    (s) => s.id.slice('tools.'.length) as ToolGroup,
  );
}

// ---------------------------------------------------------------- presets (D7)

export type StripMode = 'dates' | 'footage' | 'volume' | 'chainage';
export type IslandMode = 'view' | 'measure' | 'annotate' | 'volumes' | 'compare' | 'video' | 'road';

export const ISLAND_MODES: readonly IslandMode[] = [
  'view',
  'measure',
  'annotate',
  'volumes',
  'compare',
  'video',
  'road',
];

/** The Tools group (or Project section) a mode opens. */
export const MODE_HOME: Readonly<Record<IslandMode, SectionId>> = {
  view: 'tools.view',
  measure: 'tools.measure',
  annotate: 'tools.annotate',
  volumes: 'project.volumes',
  compare: 'project.changes',
  video: 'tools.video',
  road: 'project.road',
};

export interface Preset {
  rightTab: PanelTab;
  projectSections: readonly ProjectSection[];
  strip: StripMode;
  islandMode: IslandMode;
  stage: '3d' | 'map';
  layersOpenWide: boolean;
  toolOrder: readonly ToolGroup[];
}

export const PURPOSES: readonly ProjectPurpose[] = [
  'survey',
  'construction',
  'vertical-asset',
  'confined-space',
  'data-fusion',
  'road',
  'telecom',
];

export const PRESETS: Readonly<Record<ProjectPurpose, Preset>> = {
  survey: {
    rightTab: 'project',
    projectSections: ['volumes', 'changes', 'issues'],
    strip: 'volume',
    islandMode: 'volumes',
    stage: '3d',
    layersOpenWide: true,
    toolOrder: ['volumes', 'measure', 'checks', 'terrain'],
  },
  construction: {
    rightTab: 'project',
    projectSections: ['changes', 'issues', 'volumes'],
    strip: 'dates',
    islandMode: 'compare',
    stage: 'map',
    layersOpenWide: true,
    toolOrder: ['measure', 'annotate', 'volumes'],
  },
  'vertical-asset': {
    rightTab: 'selection',
    projectSections: ['issues', 'inThisProject'],
    strip: 'footage',
    islandMode: 'view',
    stage: '3d',
    layersOpenWide: true,
    toolOrder: ['annotate', 'measure', 'video', 'thermal'],
  },
  'confined-space': {
    rightTab: 'selection',
    projectSections: ['issues', 'inThisProject'],
    strip: 'footage',
    islandMode: 'video',
    stage: '3d',
    layersOpenWide: true,
    toolOrder: ['video', 'annotate', 'measure'],
  },
  'data-fusion': {
    rightTab: 'layers',
    projectSections: ['inThisProject', 'issues'],
    strip: 'dates',
    islandMode: 'view',
    stage: '3d',
    layersOpenWide: true,
    toolOrder: ['view', 'measure', 'annotate'],
  },
  road: {
    rightTab: 'project',
    projectSections: ['road', 'issues'],
    strip: 'chainage',
    islandMode: 'road',
    stage: 'map',
    layersOpenWide: false,
    toolOrder: ['road', 'measure', 'annotate'],
  },
  telecom: {
    rightTab: 'selection',
    projectSections: ['issues', 'inThisProject'],
    strip: 'dates',
    islandMode: 'measure',
    stage: '3d',
    layersOpenWide: true,
    toolOrder: ['measure', 'coverage', 'annotate'],
  },
};

const TYPE_FALLBACK: Readonly<Record<ProjectType, ProjectPurpose>> = {
  volumetric: 'survey',
  road: 'road',
  inspection: 'vertical-asset',
  fusion: 'data-fusion',
  twin: 'data-fusion',
};

/** The preset a project opens with: its purpose, else its type's fallback (D7). */
export function purposeOf(manifest: Pick<ProjectManifest, 'purpose' | 'type'>): ProjectPurpose {
  return projectPurpose(manifest) ?? (manifest.type ? TYPE_FALLBACK[manifest.type] : 'data-fusion');
}

/** The strip a preset asks for, or the first fallback the data can honour. */
export function stripFor(preset: Preset, data: ProjectData): StripMode {
  if (preset.strip === 'volume' && data.piles) return 'volume';
  if (preset.strip === 'footage' && (data.video || data.walks)) return 'footage';
  if (preset.strip === 'chainage' && data.road) return 'chainage';
  if (preset.strip === 'dates') return 'dates';
  return 'dates';
}

/** The strip modes this data can show (the switch offers these, whatever the preset). */
export function stripModes(data: ProjectData): StripMode[] {
  const out: StripMode[] = ['dates'];
  if (data.video || data.walks) out.push('footage');
  if (data.piles) out.push('volume');
  if (data.road) out.push('chainage');
  return out;
}

/** The island modes this data offers (Road only with a road). Never decided by the preset. */
export function islandModes(data: ProjectData): IslandMode[] {
  return ISLAND_MODES.filter((m) => m !== 'road' || data.road);
}

/** The Tools sections in the preset's order: its groups first, then the rest in D3 order. */
export function toolSections(preset: Preset, data: ProjectData): SectionDef[] {
  return sectionsOf(
    'tools',
    data,
    preset.toolOrder.map((g) => `tools.${g}` as const),
  );
}

/** The Project sections in the preset's order. */
export function projectSections(preset: Preset, data: ProjectData): SectionDef[] {
  return sectionsOf(
    'project',
    data,
    preset.projectSections.map((s) => `project.${s}` as const),
  );
}

export interface LayoutDefaults {
  tab: PanelTab;
  open: SectionId[];
  strip: StripMode;
  islandMode: IslandMode;
  stage: '3d' | 'map';
  layersOpenWide: boolean;
  video: 'docked' | 'none';
}

/** What a preset opens with for this data: fallbacks applied, the video tile following the data. */
export function applyPreset(preset: Preset, data: ProjectData): LayoutDefaults {
  const lead =
    preset.rightTab === 'project'
      ? projectSections(preset, data)[0]
      : preset.rightTab === 'tools'
        ? toolSections(preset, data)[0]
        : sectionsOf(preset.rightTab, data)[0];
  const mode = islandModes(data).includes(preset.islandMode) ? preset.islandMode : 'view';
  return {
    tab: preset.rightTab,
    open: lead ? [lead.id] : [],
    strip: stripFor(preset, data),
    islandMode: mode,
    stage: preset.stage,
    layersOpenWide: preset.layersOpenWide,
    video: data.video ? 'docked' : 'none',
  };
}

/** Every section id reachable for this data, over all four tabs (the no-gating check). */
export function reachable(preset: Preset, data: ProjectData): Set<SectionId> {
  return new Set(
    PANEL_TABS.flatMap((tab) =>
      (tab === 'tools'
        ? toolSections(preset, data)
        : tab === 'project'
          ? projectSections(preset, data)
          : sectionsOf(tab, data)
      ).map((s) => s.id),
    ),
  );
}
