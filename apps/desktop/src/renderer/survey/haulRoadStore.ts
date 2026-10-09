/**
 * Haul-road compliance in the renderer (M11 G11): the open project's runs
 * (`survey:readHaulRuns`), its prepared surfaces (`survey:surfaces`), the site defaults (the loose
 * `haul` key of `survey/settings.json`), starting `haul.analyse` jobs, and the run shown on the
 * map with its coloured centreline (`haul.geojson`). Panel: `HaulRoad.tsx`.
 */
import type { AioBridge, HaulAnalyseParams, HaulRun, HeightTiles } from '@aio/schema';
import { assetUrl, workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge, jobs } from '../shell';
import { haulDefaults, piecesOf, type HaulPiece, type HaulSiteDefaults } from './haulRoadModel';

export interface HaulState {
  projectId: string | null;
  runs: HaulRun[];
  surfaces: HeightTiles[] | null;
  defaults: HaulSiteDefaults;
  /** The run shown in the table and on the map. */
  selected: string | null;
  /** Its centreline pieces, coloured by status. */
  pieces: HaulPiece[];
  /** Whether the coloured centreline is drawn in the views. */
  shown: boolean;
  busy: boolean;
  error: string | null;
}

export const haul = createStore<HaulState>()(() => ({
  projectId: null,
  runs: [],
  surfaces: null,
  defaults: haulDefaults(undefined),
  selected: null,
  pieces: [],
  shown: true,
  busy: false,
  error: null,
}));

export function useHaul<T>(selector: (s: HaulState) => T): T {
  return useStore(haul, selector);
}

const errorOf = (
  r: { ok: true; value: { ok: boolean; error?: string } } | { ok: false; error: string },
) => (!r.ok ? r.error : r.value.ok ? null : (r.value.error ?? 'Something went wrong.'));

/** Read the project's runs, prepared surfaces and site defaults. */
export async function loadHaul(projectId: string | null): Promise<void> {
  if (!projectId) {
    haul.setState({ projectId: null, runs: [], surfaces: null, selected: null, pieces: [] });
    return;
  }
  const same = haul.getState().projectId === projectId;
  haul.setState({
    projectId,
    busy: true,
    error: null,
    ...(same ? {} : { selected: null, pieces: [] }),
  });
  const [runs, surfaces, settings] = await Promise.all([
    bridge.call('survey:readHaulRuns', { projectId }),
    bridge.call('survey:surfaces', { projectId }),
    bridge.call('survey:readSettings', { projectId }),
  ]);
  if (haul.getState().projectId !== projectId) return;
  const list = runs.ok && runs.value.ok ? runs.value.runs : [];
  haul.setState({
    busy: false,
    runs: list,
    surfaces: surfaces.ok && surfaces.value.ok ? surfaces.value.surfaces : null,
    defaults: haulDefaults(settings.ok && settings.value.ok ? settings.value.settings : undefined),
    error: errorOf(runs),
  });
  const keep = haul.getState().selected;
  const next = list.find((r) => r.id === keep) ?? list[0];
  await selectRun(next?.id ?? null);
}

/** Show a run in the table and on the map (its GeoJSON is read from the project). */
export async function selectRun(id: string | null): Promise<void> {
  const { projectId, runs } = haul.getState();
  const run = runs.find((r) => r.id === id);
  haul.setState({ selected: run?.id ?? null, pieces: [] });
  if (!projectId || !run) return;
  try {
    const res = await fetch(assetUrl(projectId, { path: `survey/haul/${run.id}/${run.geojson}` }));
    if (!res.ok) throw new Error(`Could not read the run's map (${String(res.status)}).`);
    const gj = (await res.json()) as unknown;
    if (haul.getState().selected === run.id) haul.setState({ pieces: piecesOf(gj, run) });
  } catch (e) {
    haul.setState({ error: e instanceof Error ? e.message : String(e) });
  }
}

export function setShown(shown: boolean): void {
  haul.setState({ shown });
}

/** Start `haul.analyse` on the open project; answers an error sentence or null. */
export async function startHaulRun(params: HaulAnalyseParams): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  watchHaulJobs();
  if (params.run) haul.setState({ selected: params.run });
  return jobs.getState().start({ pipeline: 'haul.analyse', project: project.root, params });
}

/**
 * Prepare the project's DSMs as survey surfaces (`survey.prepare`), one per DSM raster, for a site
 * that has none yet; answers an error sentence or null.
 */
export async function prepareDsms(): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  const dsms = project.manifest.layers.flatMap((l) =>
    l.kind === 'raster' && l.role === 'dsm' ? [l] : [],
  );
  if (dsms.length === 0) return 'The project has no DSM to prepare.';
  const surfaces = dsms.slice(0, 50).map((l) => ({
    id: `dsm-${l.capture ?? l.id}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80),
    name: l.name.slice(0, 200) || l.id,
    source: { kind: 'dsm' as const, layer: l.id },
    ...(l.capture ? { capture: l.capture } : {}),
  }));
  watchHaulJobs();
  return jobs.getState().start({
    pipeline: 'survey.prepare',
    project: project.root,
    params: { surfaces },
  });
}

/** Save the panel's interval and limits as the site's defaults (`survey/settings.json` `haul`). */
export async function saveSiteDefaults(defaults: HaulSiteDefaults): Promise<string | null> {
  const projectId = haul.getState().projectId;
  if (!projectId) return 'No project is open.';
  const r = await bridge.call('survey:readSettings', { projectId });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  const settings = { ...r.value.settings, haul: defaults };
  const w = await bridge.call('survey:writeSettings', { projectId, settings });
  const error = errorOf(w);
  if (!error) haul.setState({ defaults });
  return error;
}

let watching = false;
/** Reload the runs when a haul-road run (or a surface preparation) of the open project ends. */
export function watchHaulJobs(): void {
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (watching || !aio) return;
  watching = true;
  aio.on('jobs:event', (e) => {
    if (e.type !== 'update' || e.job.status !== 'done') return;
    if (e.job.pipeline !== 'haul.analyse' && e.job.pipeline !== 'survey.prepare') return;
    const project = workspace.getState().project;
    if (project?.root === e.job.project) void loadHaul(project.id);
  });
}

/** Fly the 3D view to a station. */
export function flyToStation(e: number, n: number, z: number | null): string | null {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  const o = project.manifest.origin;
  workspace
    .getState()
    .flyTo({ kind: 'point', p: [e - o[0], (z ?? o[2]) - o[2], -(n - o[1])], distance: 60 });
  return null;
}
