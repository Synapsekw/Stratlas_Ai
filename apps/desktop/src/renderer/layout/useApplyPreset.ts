/**
 * The open project's layout (D7): its preset (`presetFor`), what it holds (`projectData`) and the
 * person's choices for it (`layoutPrefs`) make the layout (`applyPreset`). The tab, the island's
 * mode, Map or 3D and the Layers column apply when the project opens (and on Reset); the strip,
 * the tile and Project's leading sections follow the data as it changes. Every part keeps its own
 * state and controls: the layout only says where each one starts.
 */
import { useVolumetric, volumetric } from '@aio/volumetric';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { useIsRoad } from '../road/useRoadMap';
import { shell } from '../shell';
import { bandOf } from '../shell/layoutBands';
import { useActiveSpace } from '../spaces/activeSpace';
import { useMeasure } from '../survey/measureStore';
import type { IslandMode } from '../tools/registry';
import { bottomPref, isBottomPref } from '../workspace/timelinePref';
import { videoDock } from '../workspace/video/videoDockStore';
import type { PanelTab } from '../workspace/workbench/tabsModel';
import { useHasVolumeMeasurements } from '../workspace/workbench/view';
import { workbench } from '../workspace/workbench/workbenchStore';
import { applyPreset, gainedChanges, type LayoutOverrides, type LayoutState } from './applyPreset';
import { layoutPrefs, useLayoutPrefs } from './layoutStore';
import { PRESETS, purposeOf, type Preset, type StageKind, type StripKind } from './presets';
import { projectData, readDone, storesSettled, type ProjectData } from './projectData';

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

/**
 * What the open project holds, for its layout, and whether its stores have read it yet. A store
 * still on another project counts as holding nothing: one project's piles never reach another.
 */
export function useProjectData(): { data: ProjectData; settled: boolean } | null {
  const project = useWorkspace((s) => s.project);
  const id = project?.id ?? null;
  const volId = useVolumetric((s) => s.projectId);
  const volStatus = useVolumetric((s) => s.status);
  const kitPiles = useVolumetric((s) => s.status === 'ready' && s.piles.length > 0);
  const measId = useMeasure((s) => s.projectId);
  const measStatus = useMeasure((s) => s.status);
  const measPiles = useHasVolumeMeasurements();
  const road = useIsRoad();
  const { mapAvailable } = useActiveSpace();
  return useMemo(() => {
    if (!project || id === null) return null;
    const vol = { projectId: volId, status: volStatus };
    const meas = { projectId: measId, status: measStatus };
    const piles = (readDone(id, meas) && measPiles) || (readDone(id, vol) && kitPiles);
    return {
      data: projectData(project.manifest, {
        map: mapAvailable,
        piles,
        road,
        antennas: false,
        thermal: false,
      }),
      settled: storesSettled(id, [vol, meas]),
    };
  }, [project, id, volId, volStatus, kitPiles, measId, measStatus, measPiles, road, mapAvailable]);
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
/**
 * The open project's layout, or null until it has been applied for this open (no project, or its
 * stores not read yet): its preset is the purpose chosen when it opened, never one that follows a
 * reload of its data.
 */
export function useLayout(): { preset: Preset; layout: LayoutState } | null {
  const project = useWorkspace((s) => s.project);
  const read = useProjectData();
  const overrides = useLayoutOverrides(project?.id ?? null);
  const chosen = useLayoutPrefs((s) => s.chosen);
  return useMemo(() => {
    if (!project || !read || chosen?.projectId !== project.id) return null;
    const preset = PRESETS[chosen.purpose];
    return { preset, layout: applyPreset(preset, read.data, overrides) };
  }, [project, read, overrides, chosen]);
}

/**
 * The open project's strip, from the moment it opens (null without a project). Until its layout
 * applies (its stores still reading, a slow computer) the strip is the one its own purpose and the
 * person's pick give with the data read so far, so it never shows one side and then jumps to the
 * other at the settle, and a side picked before the settle shows at once and holds through it.
 */
export function useStrip(): StripKind | null {
  const project = useWorkspace((s) => s.project);
  const read = useProjectData();
  const overrides = useLayoutOverrides(project?.id ?? null);
  const applied = useLayout();
  return useMemo(() => {
    if (applied) return applied.layout.strip;
    if (!project || !read) return null;
    const preset = PRESETS[purposeOf(project.manifest, read.data)];
    return applyPreset(preset, read.data, overrides).strip;
  }, [applied, project, read, overrides]);
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
  const project = useWorkspace((s) => s.project);
  const projectId = project?.id ?? null;
  const read = useProjectData();
  const current = useLayout();
  const overrides = useLayoutOverrides(projectId);
  const resetSeq = useLayoutPrefs((s) => s.resetSeq);
  // a project already open when the workspace mounts (App's project subscription saw no change):
  // its volumes are read now, so the layout can settle
  useEffect(() => {
    if (!projectId) return;
    const v = volumetric.getState();
    if (v.projectId !== projectId && v.status !== 'loading') void v.load();
  }, [projectId]);
  useEffect(() => {
    const prefs = layoutPrefs.getState();
    if (!project || !projectId || !read) {
      opened.current = null;
      last.current = null;
      prefs.choosePurpose(null);
      setFoldWide(false);
      return;
    }
    const key = `${projectId}#${String(resetSeq)}`;
    // another project is open now (A, then B before its data was read, then A again): the last
    // open's key no longer holds, so the layout applies again for this one
    if (opened.current !== null && !opened.current.startsWith(`${projectId}#`)) {
      opened.current = null;
      last.current = null;
    }
    if (opened.current !== key) {
      // only once the project's own measurements and volumes are read: a store still on the last
      // project would hand it that project's piles
      if (!read.settled) return;
      // the purpose is chosen once per open (a Reset keeps it): the layout never moves under the
      // person because the data reloaded
      const chosen = prefs.chosen?.projectId === projectId ? prefs.chosen : null;
      const purpose = chosen?.purpose ?? purposeOf(project.manifest, read.data);
      prefs.choosePurpose({ projectId, purpose });
      const preset = PRESETS[purpose];
      const layout = applyPreset(preset, read.data, overrides);
      opened.current = key;
      last.current = layout;
      applyOnOpen(preset, layout, overrides);
      return;
    }
    if (!current) return;
    const { preset, layout } = current;
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
  }, [project, projectId, read, current, overrides, resetSeq]);
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

// the Layers column opened by hand where the project's preset folds it, in a wide window: the
// person's choice (a toggle in a narrower band never changes the wide default)
shell.subscribe((s, prev) => {
  if (
    prev.layersFoldWide &&
    !s.layersFoldWide &&
    !foldingByPreset &&
    bandOf(s.windowWidth) === 'wide'
  ) {
    const id = openId();
    if (id && s.screen === 'scene') layoutPrefs.getState().choose(id, { layersOpenWide: true });
  }
});
