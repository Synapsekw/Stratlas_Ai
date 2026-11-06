/**
 * A preset and the project's data make the layout the workspace opens on (D7): first each preset
 * value the data cannot honour falls back (Volume over time without piles, Footage without video,
 * Chainage without a road become Dates; a Project section without its data is not listed; an
 * island mode without its data is View), then the person's own choices for this project win where
 * the data can honour them. A choice the data cannot honour now is ignored, never dropped: it
 * holds again once the data is back. Pure.
 */
import type { IslandMode } from '../tools/registry';
import type { PanelTab, SectionId } from '../workspace/workbench/tabsModel';
import type { Preset, StageKind, StripKind } from './presets';
import type { ProjectData } from './projectData';

/** Where the video shows: the tile, the floating window, closed, or none (no video). */
export type VideoTile = 'docked' | 'floating' | 'closed' | 'none';

/** What the person changed for this project (`quadrion.layout.<projectId>`; the video's own store). */
export interface LayoutOverrides {
  rightTab?: PanelTab;
  strip?: StripKind;
  islandMode?: IslandMode;
  stage?: StageKind;
  layersOpenWide?: boolean;
  video?: Exclude<VideoTile, 'none'>;
}

export interface LayoutState {
  rightTab: PanelTab;
  /** Project's leading sections with their data, in the preset's order. */
  projectSections: SectionId[];
  strip: StripKind;
  islandMode: IslandMode;
  stage: StageKind;
  layersOpenWide: boolean;
  toolOrder: Preset['toolOrder'];
  videoTile: VideoTile;
}

const SECTION_NEEDS: Partial<Record<SectionId, (d: ProjectData) => boolean>> = {
  'project.volumes': (d) => d.piles,
  'project.changes': (d) => d.dated,
  'project.road': (d) => d.road,
  'project.digest': (d) => d.dated,
};

export function stripHonoured(strip: StripKind, d: ProjectData): boolean {
  switch (strip) {
    case 'volume':
      return d.piles;
    case 'footage':
      return d.video || d.walks;
    case 'chainage':
      return d.road;
    case 'dates':
      return true;
  }
}

export function islandModeHonoured(mode: IslandMode, d: ProjectData): boolean {
  switch (mode) {
    case 'volumes':
      return d.piles;
    case 'video':
      return d.video;
    case 'road':
      return d.road;
    case 'compare':
      // a road compares by chainage, not by date (the island's own rule)
      return !d.road && (d.dated || d.video);
    default:
      return true;
  }
}

export function applyPreset(
  preset: Preset,
  data: ProjectData,
  overrides: LayoutOverrides,
): LayoutState {
  const strip =
    overrides.strip !== undefined && stripHonoured(overrides.strip, data)
      ? overrides.strip
      : stripHonoured(preset.strip, data)
        ? preset.strip
        : 'dates';
  const islandMode =
    overrides.islandMode !== undefined && islandModeHonoured(overrides.islandMode, data)
      ? overrides.islandMode
      : islandModeHonoured(preset.islandMode, data)
        ? preset.islandMode
        : 'view';
  return {
    rightTab: overrides.rightTab ?? preset.rightTab,
    projectSections: preset.projectSections.filter((s) => SECTION_NEEDS[s]?.(data) ?? true),
    strip,
    islandMode,
    // a project with no layer yet opens on 3D, where its import hint is
    stage: overrides.stage ?? (data.empty ? '3d' : preset.stage),
    layersOpenWide: overrides.layersOpenWide ?? preset.layersOpenWide,
    toolOrder: preset.toolOrder,
    videoTile: data.video ? (overrides.video ?? 'docked') : 'none',
  };
}

/** Applied on open only: the person's place is never moved by new data. */
const ON_OPEN: ReadonlySet<keyof LayoutState> = new Set(['rightTab', 'islandMode', 'stage']);

/**
 * What a project that gained data (its first video, its piles read) changes of the layout on
 * screen: the strip, the tile, the leading sections; never the tab, the island's mode or the
 * stage, which apply when the project opens.
 */
export function gainedChanges(before: LayoutState, after: LayoutState): Partial<LayoutState> {
  const out: Partial<Record<keyof LayoutState, unknown>> = {};
  for (const key of Object.keys(after) as (keyof LayoutState)[]) {
    if (ON_OPEN.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  return out as Partial<LayoutState>;
}
