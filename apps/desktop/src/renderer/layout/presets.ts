/**
 * Layout presets per project type (UI revision D7, W13). A preset is code, not data: it says what
 * the workspace opens on (the right panel's tab, Project's first sections, the bottom strip, the
 * island's mode, Map or 3D, the Layers column in a wide window, the Tools tab's first groups) and
 * nothing more. It never decides what exists: the project's data does (`applyPreset`), and every
 * tool, section, mode and import stays reachable in every project.
 */
import {
  projectPurpose,
  type ProjectManifest,
  type ProjectPurpose,
  type ProjectType,
} from '@aio/schema';
import type { IslandMode, ToolGroup } from '../tools/registry';
import type { PanelTab, SectionId } from '../workspace/workbench/tabsModel';

/** What the bottom strip shows: the dates, the footage, the volume over time or the chainage. */
export type StripKind = 'dates' | 'footage' | 'volume' | 'chainage';
export type StageKind = '3d' | 'map';

export interface Preset {
  /** The right panel's tab on open. */
  rightTab: PanelTab;
  /** Project's sections that lead, open, in this order (the rest follow in the tab's order). */
  projectSections: SectionId[];
  strip: StripKind;
  islandMode: IslandMode;
  stage: StageKind;
  /** The Layers column open in a wide window (1440 px and up). */
  layersOpenWide: boolean;
  /** The Tools tab's first groups (the rest follow in the registry's order, none removed). */
  toolOrder: ToolGroup[];
}

/** The D7 table. */
export const PRESETS: Readonly<Record<ProjectPurpose, Preset>> = {
  survey: {
    rightTab: 'project',
    projectSections: ['project.volumes', 'project.changes', 'project.issues'],
    strip: 'volume',
    islandMode: 'volumes',
    stage: '3d',
    layersOpenWide: true,
    toolOrder: ['volumes', 'measure', 'terrain', 'checks'],
  },
  construction: {
    rightTab: 'project',
    projectSections: ['project.changes', 'project.issues', 'project.volumes'],
    strip: 'dates',
    islandMode: 'compare',
    stage: 'map',
    layersOpenWide: true,
    toolOrder: ['measure', 'terrain', 'checks', 'volumes'],
  },
  'vertical-asset': {
    rightTab: 'selection',
    projectSections: ['project.issues', 'project.inThisProject'],
    strip: 'footage',
    islandMode: 'view',
    stage: '3d',
    layersOpenWide: true,
    toolOrder: ['measure', 'annotate', 'engineering', 'thermal'],
  },
  'confined-space': {
    rightTab: 'selection',
    projectSections: ['project.issues', 'project.inThisProject'],
    strip: 'footage',
    islandMode: 'video',
    stage: '3d',
    layersOpenWide: true,
    toolOrder: ['video', 'measure', 'annotate', 'pointcloud'],
  },
  'data-fusion': {
    rightTab: 'layers',
    projectSections: ['project.inThisProject', 'project.issues'],
    strip: 'dates',
    islandMode: 'view',
    stage: '3d',
    layersOpenWide: true,
    toolOrder: ['view', 'pointcloud', 'measure'],
  },
  road: {
    rightTab: 'project',
    projectSections: ['project.road', 'project.issues'],
    strip: 'chainage',
    islandMode: 'road',
    stage: 'map',
    layersOpenWide: false,
    toolOrder: ['road', 'measure', 'annotate'],
  },
  telecom: {
    rightTab: 'selection',
    projectSections: ['project.issues', 'project.inThisProject'],
    strip: 'dates',
    islandMode: 'measure',
    stage: '3d',
    layersOpenWide: true,
    toolOrder: ['measure', 'engineering', 'coverage', 'annotate'],
  },
};

/** A project without a purpose: the purpose its `type` stands for (D7). */
export const TYPE_PURPOSE: Readonly<Record<ProjectType, ProjectPurpose>> = {
  volumetric: 'survey',
  road: 'road',
  inspection: 'vertical-asset',
  fusion: 'data-fusion',
  twin: 'data-fusion',
};

/**
 * Without either (an imported kit project, an older folder): the inspection row, which opens as
 * the workspace always has (Selection, View, 3D, the strip its data gives).
 */
export const FALLBACK_PURPOSE: ProjectPurpose = 'vertical-asset';

/** The purpose a project's layout follows: its own, else its type's, else the fallback. */
export function purposeOf(manifest: Pick<ProjectManifest, 'purpose' | 'type'>): ProjectPurpose {
  return (
    projectPurpose(manifest) ?? (manifest.type ? TYPE_PURPOSE[manifest.type] : FALLBACK_PURPOSE)
  );
}

export function presetFor(manifest: Pick<ProjectManifest, 'purpose' | 'type'>): Preset {
  return PRESETS[purposeOf(manifest)];
}
