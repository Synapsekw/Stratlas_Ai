/**
 * The open project's layout (D7): its preset (`presetFor`), what it holds (`projectData`) and the
 * person's choices for it (`layoutPrefs`) make the layout (`applyPreset`). The tab, the island's
 * mode, Map or 3D and the Layers column apply when the project opens (and on Reset); the strip,
 * the tile and Project's leading sections follow the data as it changes. Every part keeps its own
 * state and controls: the layout only says where each one starts.
 */
import { useVolumetric } from '@aio/volumetric';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { useIsRoad } from '../road/useRoadMap';
import { shell } from '../shell';
import type { IslandMode } from '../tools/registry';
import { bottomPref, isBottomPref } from '../workspace/timelinePref';
import { videoDock } from '../workspace/video/videoDockStore';
import type { PanelTab } from '../workspace/workbench/tabsModel';
import { useHasVolumeMeasurements } from '../workspace/workbench/view';
import { workbench } from '../workspace/workbench/workbenchStore';
import { applyPreset, gainedChanges, type LayoutOverrides, type LayoutState } from './applyPreset';
import { layoutPrefs, useLayoutPrefs } from './layoutStore';
import { presetFor, type Preset, type StageKind, type StripKind } from './presets';
import { projectData, type ProjectData } from './projectData';

const NO_OVERRIDES: LayoutOverrides = {};

/** The preset folds or opens the Layers column (not the person). */
let foldingByPreset = false;
function setFoldWide(on: boolean): void {
  if (shell.getState().layersFoldWide === on) return;
  foldingByPreset = true;
  try {
    shell.setState({ layersFoldWide: on });
  } finally {
    foldingByPreset = false;
  }
}

/** What the open project holds, for its layout. */
export function useProjectData(): ProjectData | null {
  const project = useWorkspace((s) => s.project);
  const kit = useVolumetric((s) => s.status === 'ready' && s.piles.length > 0);
  const piles = useHasVolumeMeasurements() || kit;
  const road = useIsRoad();
  return useMemo(
    () =>
      project
        ? projectData(project.manifest, { piles, road, antennas: false, thermal: false })
        : null,
    [project, piles, road],
  );
}

/**
 * The person's choices for the project: the saved ones, the video's place (its own store) and,
 * until a strip is chosen here, the old "Dates | Footage" choice.
 */
export function useLayoutOverrides(projectId: string | null): LayoutOverrides {
  const saved = useLayoutPrefs((s) => (projectId ? s.byProject[projectId] : undefined));
  const video = useStore(videoDock, (s) => (projectId ? s.byProject[projectId] : undefined));
  const oldStrip = useStore(bottomPref, (s) => (projectId ? s.byProject[projectId] : undefined));
  return useMemo(() => {
    if (!projectId) return NO_OVERRIDES;
    const o = saved ?? layoutPrefs.getState().peek(projectId);
    return {
      ...o,
      ...(o.strip === undefined && oldStrip !== undefined && { strip: oldStrip }),
      ...(video !== undefined && { video }),
    };
  }, [projectId, saved, video, oldStrip]);
}

/** The open project's layout, or null without a project. */
export function useLayout(): { preset: Preset; layout: LayoutState } | null {
  const project = useWorkspace((s) => s.project);
  const data = useProjectData();
  const overrides = useLayoutOverrides(project?.id ?? null);
  return useMemo(() => {
    if (!project || !data) return null;
    const preset = presetFor(project.manifest);
    return { preset, layout: applyPreset(preset, data, overrides) };
  }, [project, data, overrides]);
}

/** Project's first section with its data, brought forward with the Project tab. */
function projectSection(preset: Preset, layout: LayoutState) {
  return layout.projectSections[0] ?? preset.projectSections.at(-1);
}

/** Bring the layout's tab forward as the project's (not the person's) choice. */
function showTab(preset: Preset, layout: LayoutState): void {
  const wb = workbench.getState();
  const tab = layout.rightTab;
  wb.show(tab, tab === 'project' ? projectSection(preset, layout) : undefined);
  workbench.setState({ followed: tab });
}

/** What applies when the project opens, and again on Reset. */
function applyOnOpen(preset: Preset, layout: LayoutState, overrides: LayoutOverrides): void {
  const wb = workbench.getState();
  // Project's leading sections open (each shows once its data is there)
  const sections = { ...wb.sections };
  for (const id of preset.projectSections) sections[id] = true;
  workbench.setState({ sections });
  showTab(preset, layout);
  // the island's mode: the saved or the preset's, as it is; the island lists it once its data is
  // read (piles, a road), and until then shows View
  layoutPrefs.getState().askIsland(overrides.islandMode ?? preset.islandMode);
  const sh = shell.getState();
  // a video-first project opens on Split (store.ts): that stays the app's choice
  if (sh.stageMode !== 'split' && sh.stageMode !== layout.stage)
    shell.setState({ stageMode: layout.stage, stageAuto: false });
  setFoldWide(!layout.layersOpenWide);
}

/**
 * The project (and Reset) the layout was applied for, and the layout then: kept outside the hook,
 * so a return to the Scene from another screen does not open the project again.
 */
const opened: { current: string | null } = { current: null };
const last: { current: LayoutState | null } = { current: null };

/**
 * Mounted once in the workspace: applies the open project's layout on open and on Reset, and the
 * data-led parts as the data comes.
 */
export function useApplyPreset(): void {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const current = useLayout();
  const overrides = useLayoutOverrides(projectId);
  const resetSeq = useLayoutPrefs((s) => s.resetSeq);
  useEffect(() => {
    if (!projectId || !current) {
      opened.current = null;
      last.current = null;
      setFoldWide(false);
      return;
    }
    const { preset, layout } = current;
    const key = `${projectId}#${String(resetSeq)}`;
    if (opened.current !== key) {
      opened.current = key;
      last.current = layout;
      applyOnOpen(preset, layout, overrides);
      return;
    }
    const before = last.current;
    last.current = layout;
    if (!before) return;
    const gained = gainedChanges(before, layout);
    // Project's first section came with its data (the piles read after the open): it comes
    // forward while the Project tab is still the project's own choice
    if (gained.projectSections && layout.rightTab === 'project') {
      const wb = workbench.getState();
      if (wb.followed === 'project' && wb.panel === 'project') showTab(preset, layout);
    }
  }, [projectId, current, overrides, resetSeq]);
}

// ---------------------------------------------------------------- the person's choices

const openId = (): string | null => workspace.getState().project?.id ?? null;

/** The person picked a tab on the panel's tab bar. */
export function chooseTab(tab: PanelTab): void {
  const id = openId();
  if (id) layoutPrefs.getState().choose(id, { rightTab: tab });
}

/** The person picked Dates or Footage on the strip's switch. */
export function chooseStrip(strip: StripKind): void {
  const id = openId();
  if (!id) return;
  layoutPrefs.getState().choose(id, { strip });
  // the old per-project choice follows, for an older build reading it
  if (isBottomPref(strip)) bottomPref.getState().set(id, strip);
}

/** The person picked Map or 3D (the island's view tiles, the palette, the keys). */
export function chooseStage(mode: StageKind | 'split'): void {
  const id = openId();
  if (id && mode !== 'split') layoutPrefs.getState().choose(id, { stage: mode });
}

/** The person picked an island mode. */
export function chooseIslandMode(mode: IslandMode): void {
  const id = openId();
  if (!id) return;
  layoutPrefs.getState().choose(id, { islandMode: mode });
  // an island mounted again (another view) comes back on it
  const ask = layoutPrefs.getState().islandAsk;
  if (ask && ask.mode !== mode) layoutPrefs.setState({ islandAsk: { ...ask, mode } });
}

/**
 * "Reset layout to project defaults": the project's choices go (the tab, the strip, the island's
 * mode, Map or 3D, the Layers column, the video's place) and the preset applies again.
 */
export function resetLayout(): void {
  const id = openId();
  if (!id) return;
  const drop = <T>(byProject: Readonly<Record<string, T>>): Record<string, T> =>
    Object.fromEntries(Object.entries(byProject).filter(([k]) => k !== id));
  if (videoDock.getState().byProject[id] !== undefined)
    videoDock.setState({ byProject: drop(videoDock.getState().byProject) });
  if (bottomPref.getState().byProject[id] !== undefined)
    bottomPref.setState({ byProject: drop(bottomPref.getState().byProject) });
  layoutPrefs.getState().reset(id);
}

// the Layers column opened by hand where the project's preset folds it: the person's choice
shell.subscribe((s, prev) => {
  if (prev.layersFoldWide && !s.layersFoldWide && !foldingByPreset) {
    const id = openId();
    if (id && s.screen === 'scene') layoutPrefs.getState().choose(id, { layersOpenWide: true });
  }
});
