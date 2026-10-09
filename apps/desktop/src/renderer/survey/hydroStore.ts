/**
 * Hydrology in the renderer (M11 G10, PRD HYD-1 to HYD-3): the prepared surfaces and the site's
 * runs (`survey:surfaces`, `survey:readHydroRuns`), starting `hydro.flood`, `hydro.flow` and
 * `hydro.rainfall` jobs (and `survey.prepare` when the site has no prepared surface yet), the run
 * shown on the map, the rainfall frame, and picking a point on the map. Panels: `Hydro.tsx`,
 * `HydroForms.tsx`; map drawing: `hydroMap.ts`.
 */
import type {
  AioBridge,
  HeightTiles,
  HydroRun,
  PipelineName,
  ProjectManifest,
  SurveyPrepareParams,
} from '@aio/schema';
import { bilinear, TileSurface } from '@aio/survey';
import { assetUrl, workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge, jobs } from '../shell';

export type HydroTab = 'flood' | 'runoff' | 'catchment' | 'rainfall';
export type PickKind = 'level' | 'seed' | 'drop' | 'outlet';
const HYDRO_PIPELINES: readonly string[] = ['hydro.flood', 'hydro.flow', 'hydro.rainfall'];

export interface HydroState {
  projectId: string | null;
  surfaces: HeightTiles[];
  runs: HydroRun[];
  /** The run shown on the map and in the results. */
  selected: string | null;
  /** The rainfall frame shown (index into `results.frames`). */
  frame: number;
  tab: HydroTab;
  /** The panel is open (it closes while a point is picked on the map). */
  open: boolean;
  /** Waiting for a click on the map for this. */
  pick: PickKind | null;
  /** The last point picked, by kind (E, N), and the height there for `level`. */
  picked: { kind: PickKind; e: number; n: number; z: number | null; at: number } | null;
  /** A run started from the panel and not finished yet: its id. */
  pending: string | null;
  /** What the forms hold, by field, kept while the panel is closed for a pick. */
  drafts: Record<string, string>;
  busy: boolean;
  error: string | null;
}

const initial = (): HydroState => ({
  projectId: null,
  surfaces: [],
  runs: [],
  selected: null,
  frame: 0,
  tab: 'flood',
  open: false,
  pick: null,
  picked: null,
  pending: null,
  drafts: {},
  busy: false,
  error: null,
});

export const hydro = createStore<HydroState>()(initial);

export function useHydro<T>(selector: (s: HydroState) => T): T {
  return useStore(hydro, selector);
}

/** The runs of the open project, newest first, and its prepared surfaces. */
export async function loadHydro(projectId: string | null): Promise<void> {
  if (!projectId) {
    hydro.setState(initial());
    return;
  }
  const switched = hydro.getState().projectId !== projectId;
  hydro.setState({
    projectId,
    busy: true,
    error: null,
    ...(switched
      ? { runs: [], surfaces: [], selected: null, pending: null, picked: null, drafts: {} }
      : {}),
  });
  const [s, r] = await Promise.all([
    bridge.call('survey:surfaces', { projectId }),
    bridge.call('survey:readHydroRuns', { projectId }),
  ]);
  if (hydro.getState().projectId !== projectId) return;
  const error = !s.ok
    ? s.error
    : !s.value.ok
      ? s.value.error
      : !r.ok
        ? r.error
        : !r.value.ok
          ? r.value.error
          : null;
  const surfaces = s.ok && s.value.ok ? s.value.surfaces : [];
  const runs = r.ok && r.value.ok ? r.value.runs : [];
  const { selected, pending } = hydro.getState();
  const done = pending !== null && runs.some((x) => x.id === pending);
  hydro.setState({
    busy: false,
    error,
    surfaces,
    runs,
    selected: done ? pending : selected && runs.some((x) => x.id === selected) ? selected : null,
    pending: done ? null : pending,
    frame: done ? 0 : hydro.getState().frame,
  });
}

/** A run id that sorts by time: `flood-20261009-101500`. */
export function newRunId(kind: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const d = `${String(now.getFullYear())}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const t = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${kind}-${d}-${t}`;
}

/** Start a hydrology job for the open project; answers an error sentence or null. */
export async function startHydro(
  pipeline: 'hydro.flood' | 'hydro.flow' | 'hydro.rainfall',
  params: Record<string, unknown>,
  kind: string,
): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  watchHydroJobs();
  const run = newRunId(kind);
  const err = await jobs.getState().start({
    pipeline,
    project: project.root,
    params: { ...params, run },
  });
  if (err) return err;
  hydro.setState({ pending: run, error: null });
  return null;
}

// ------------------------------------------------------------------------------------ regions

export type HydroJob = 'hydro.flood' | 'hydro.flow' | 'hydro.rainfall';

/** The cells each tool reads at most (the pipelines' `MAX_CELLS`); a region narrows a larger site. */
export const HYDRO_CELL_LIMITS: Record<HydroJob, number> = {
  'hydro.flood': 25_000_000,
  'hydro.flow': 4_000_000,
  'hydro.rainfall': 4_000_000,
};

const TOOL_NAME: Record<HydroJob, string> = {
  'hydro.flood': 'Flood to level',
  'hydro.flow': 'Runoff and catchment',
  'hydro.rainfall': 'Direct rainfall',
};

export type Ring = [number, number][];

/**
 * The cells a run reads (columns, rows) at `cellM` (the surface's own cell by default) over the
 * surface's extent, or over the part of it the region's box covers, as `load_surface` counts them.
 * Null when the region misses the surface.
 */
export function runCells(
  surface: Pick<HeightTiles, 'bounds' | 'cellM' | 'originE' | 'originN'>,
  region: Ring | null,
  cellM?: number,
): { cols: number; rows: number; cellM: number } | null {
  const [minE, minN, , maxE, maxN] = surface.bounds;
  let box = [minE, minN, maxE, maxN];
  if (region && region.length >= 3) {
    const xs = region.map((p) => p[0]);
    const ys = region.map((p) => p[1]);
    box = [
      Math.max(Math.min(...xs), minE),
      Math.max(Math.min(...ys), minN),
      Math.min(Math.max(...xs), maxE),
      Math.min(Math.max(...ys), maxN),
    ];
  }
  const c = cellM ?? surface.cellM;
  const [w0 = 0, s0 = 0, e0 = 0, n0 = 0] = box;
  const i0 = Math.max(0, Math.floor((w0 - surface.originE) / c + 1e-9));
  const j0 = Math.max(0, Math.floor((s0 - surface.originN) / c + 1e-9));
  const i1 = Math.ceil((e0 - surface.originE) / c - 1e-9);
  const j1 = Math.ceil((n0 - surface.originN) / c - 1e-9);
  if (i1 <= i0 || j1 <= j0) return null;
  return { cols: i1 - i0, rows: j1 - j0, cellM: c };
}

const count = new Intl.NumberFormat('en');

/**
 * Why a run needs a region (the area is above the tool's cell limit, or the region misses the
 * surface), or null when it can run as it is.
 */
export function regionNeed(
  pipeline: HydroJob,
  surface: Pick<HeightTiles, 'bounds' | 'cellM' | 'originE' | 'originN'> | undefined,
  region: Ring | null,
  cellM?: number,
): string | null {
  if (!surface) return null;
  const cells = runCells(surface, region, cellM);
  if (!cells) return 'The region does not overlap the surface. Pick or draw another one.';
  const limit = HYDRO_CELL_LIMITS[pipeline];
  if (cells.cols * cells.rows <= limit) return null;
  const area = `${count.format(cells.cols)} by ${count.format(cells.rows)} cells at ${String(cells.cellM)} m`;
  return region
    ? `The region is ${area}; ${TOOL_NAME[pipeline]} takes at most ${count.format(limit)} cells. Draw a smaller region.`
    : `The surface is ${area}; ${TOOL_NAME[pipeline]} takes at most ${count.format(limit)} cells. Pick or draw a region around the area of interest.`;
}

/** A pipeline refusal for too many cells (the job's own words), so the panel asks for a region. */
export function isCellLimitError(error: string | null): boolean {
  return error !== null && /takes at most [\d,]+ cells/.test(error);
}

/** The params of a run with its region, when one is chosen. */
export function withRegion(
  params: Record<string, unknown>,
  region: Ring | null,
): Record<string, unknown> {
  return region && region.length >= 3 ? { ...params, region } : params;
}

/** The DSM layers of a project as `survey.prepare` surfaces (`dsm-<capture or layer>`). */
export function prepareParams(manifest: ProjectManifest): SurveyPrepareParams | null {
  const surfaces: SurveyPrepareParams['surfaces'] = [];
  for (const l of manifest.layers) {
    if (l.kind !== 'raster' || l.role !== 'dsm') continue;
    const id = `dsm-${l.capture ?? l.id}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
    if (surfaces.some((s) => s.id === id)) continue;
    surfaces.push({
      id,
      name: l.name.slice(0, 200),
      source: { kind: 'dsm', layer: l.id },
      ...(l.capture ? { capture: l.capture } : {}),
    });
  }
  return surfaces.length ? { surfaces: surfaces.slice(0, 50) } : null;
}

/** Prepare the project's DSMs so the hydrology tools can read them. */
export async function prepareSurfaces(): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  const params = prepareParams(project.manifest);
  if (!params) return 'This project has no DSM to prepare.';
  watchHydroJobs();
  return jobs.getState().start({ pipeline: 'survey.prepare', project: project.root, params });
}

let watching = false;
/** Reload the runs and surfaces when a hydrology or prepare job of the open project ends. */
export function watchHydroJobs(): void {
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (watching || !aio) return;
  watching = true;
  aio.on('jobs:event', (e) => {
    if (e.type !== 'update') return;
    const pipeline: PipelineName = e.job.pipeline;
    if (!HYDRO_PIPELINES.includes(pipeline) && pipeline !== 'survey.prepare') return;
    const project = workspace.getState().project;
    if (project?.root !== e.job.project) return;
    if (e.job.status === 'done') void loadHydro(project.id);
    else if (e.job.status === 'failed' || e.job.status === 'cancelled') {
      hydro.setState({
        pending: null,
        error:
          e.job.status === 'failed'
            ? (e.job.error ?? 'The hydrology job failed.')
            : 'The job was cancelled.',
      });
    }
  });
}

/** The URL of a file of a run's folder. */
export function runFileUrl(projectId: string, run: HydroRun, file: string): string {
  return assetUrl(projectId, { path: `survey/hydro/${run.id}/${file}` });
}

/** The run shown, if any. */
export function selectedRun(s: HydroState): HydroRun | null {
  return s.runs.find((r) => r.id === s.selected) ?? null;
}

/** A form field kept in the store (it survives the panel closing while a point is picked). */
export function useDraft(
  key: string,
  initial: string,
): [string, (v: string | ((prev: string) => string)) => void] {
  const value = useHydro((s) => s.drafts[key] ?? initial);
  const set = (v: string | ((prev: string) => string)) => {
    const drafts = hydro.getState().drafts;
    const next = typeof v === 'function' ? v(drafts[key] ?? initial) : v;
    hydro.setState({ drafts: { ...drafts, [key]: next } });
  };
  return [value, set];
}

// ------------------------------------------------------------------------------------ picking

/** Wait for a click on the map (the panel closes meanwhile and opens again with the point). */
export function startPick(kind: PickKind): void {
  hydro.setState({ pick: kind, open: false, error: null });
}

export function cancelPick(): void {
  if (hydro.getState().pick) hydro.setState({ pick: null, open: true });
}

/** A point picked on the map: the height under it for a level, then the panel again. */
export async function picked(e: number, n: number): Promise<void> {
  const { pick, projectId, surfaces } = hydro.getState();
  if (!pick) return;
  hydro.setState({ pick: null });
  let z: number | null = null;
  if (pick === 'level' && projectId) {
    const surface = surfaces.find((s) => s.id === activeSurface) ?? surfaces[0];
    if (surface) z = await heightAt(projectId, surface, e, n).catch(() => null);
  }
  hydro.setState({ picked: { kind: pick, e, n, z, at: Date.now() }, open: true });
}

/** The surface the forms run on (set by the panel), for heights under a picked point. */
let activeSurface: string | null = null;
export function setActiveSurface(id: string | null): void {
  activeSurface = id;
}

const tileSurfaces = new Map<string, TileSurface>();

/** The height of a prepared surface at (E, N), or null where it has no data. */
export async function heightAt(
  projectId: string,
  s: HeightTiles,
  e: number,
  n: number,
): Promise<number | null> {
  const key = `${projectId}/${s.id}/${s.fingerprint}`;
  let surface = tileSurfaces.get(key);
  if (!surface) {
    surface = new TileSurface(key, s, async (col, row) => {
      const r = await fetch(
        assetUrl(projectId, {
          path: `survey/surfaces/${s.id}/0/${String(col)}_${String(row)}.bin`,
        }),
      );
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    });
    tileSurfaces.set(key, surface);
  }
  const z = await bilinear(
    surface,
    new Float64Array([e - s.originE]),
    new Float64Array([n - s.originN]),
    0,
    0,
  );
  const v = z[0];
  return v !== undefined && Number.isFinite(v) ? v : null;
}
