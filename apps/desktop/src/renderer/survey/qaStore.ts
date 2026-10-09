/**
 * Survey QA, cleanups and crops in the renderer (M11 G8, data-conventions section 29): the QA
 * results of the open project (`survey/qa/<capture>.json`), its prepared surfaces, its terrain
 * edits (`survey/cleanups.json`) and the panel that is open. The checks and the cleanups run as
 * pipeline jobs (`survey.prepare` when a survey has no prepared surface yet, `survey.qa`,
 * `survey.cleanup`); a hold is released only by a person, with a note (`survey:releaseHold`).
 */
import type {
  HeightTiles,
  JobRecord,
  PipelineName,
  ProjectManifest,
  QaLevel,
  SurveyQa,
  TerrainEdit,
  TerrainEditsFile,
} from '@aio/schema';
import { createStore, useStore } from 'zustand';
import type { Jobs } from '../jobs';
import { bridge, jobs } from '../shell';

export type QaPanel = 'qa' | 'cleanup' | 'surveys' | 'history' | null;

export interface QaState {
  projectId: string | null;
  root: string | null;
  readOnly: boolean;
  /** QA results by capture id. */
  qa: Record<string, SurveyQa>;
  surfaces: HeightTiles[];
  edits: TerrainEditsFile;
  panel: QaPanel;
  /** What is running (a short sentence), or null. */
  busy: string | null;
  /** The last error or confirmation line. */
  message: { kind: 'ok' | 'error'; text: string } | null;
}

const emptyEdits = (): TerrainEditsFile => ({ schema: 'aio.terrain-edits/1', edits: [] });

export const qaStore = createStore<QaState>()(() => ({
  projectId: null,
  root: null,
  readOnly: false,
  qa: {},
  surfaces: [],
  edits: emptyEdits(),
  panel: null,
  busy: null,
  message: null,
}));

export function useQa<T>(selector: (s: QaState) => T): T {
  return useStore(qaStore, selector);
}

const set = (patch: Partial<QaState>) => {
  qaStore.setState(patch);
};
const get = () => qaStore.getState();

/** A held survey: a failed check a person has not released. */
export const isHeld = (qa: SurveyQa | undefined): boolean =>
  qa?.status === 'hold' || qa?.status === 'fail';

export const LEVEL_LABELS: Record<QaLevel, string> = {
  strict: 'Strict',
  moderate: 'Moderate',
  lenient: 'Lenient',
  off: 'Off',
};

/** RMSE limits by level, metres (the site's `qa.rmseM` replaces its own level's). */
export const RMSE_LIMIT: Record<Exclude<QaLevel, 'off'>, number> = {
  strict: 0.05,
  moderate: 0.1,
  lenient: 0.2,
};

export function openQaPanel(panel: QaPanel): void {
  set({ panel, message: null });
}

// ---------------------------------------------------------------- loading

export async function loadQa(projectId: string | null, root: string | null, readOnly: boolean) {
  if (projectId !== get().projectId) {
    set({
      projectId,
      root,
      readOnly,
      qa: {},
      surfaces: [],
      edits: emptyEdits(),
      busy: null,
      message: null,
    });
  }
  if (!projectId) return;
  await refreshQa();
}

/** Read the QA results, the prepared surfaces and the terrain edits again. */
export async function refreshQa(): Promise<void> {
  const projectId = get().projectId;
  if (!projectId) return;
  const [q, s, e] = await Promise.all([
    bridge.call('survey:readQa', { projectId }),
    bridge.call('survey:surfaces', { projectId }),
    bridge.call('survey:readTerrainEdits', { projectId }),
  ]);
  if (get().projectId !== projectId) return;
  const patch: Partial<QaState> = {};
  if (q.ok && q.value.ok) {
    patch.qa = Object.fromEntries(q.value.files.map((f) => [f.capture, f]));
    patch.readOnly = get().readOnly || q.value.readOnly;
  }
  if (s.ok && s.value.ok) patch.surfaces = s.value.surfaces;
  if (e.ok && e.value.ok) patch.edits = e.value.file;
  set(patch);
}

// ---------------------------------------------------------------- jobs

const ENDED: ReadonlySet<JobRecord['status']> = new Set([
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);

/** The job's record once it has ended. */
export function waitForJob(id: string): Promise<JobRecord> {
  const ended = (st: Jobs): JobRecord | null => {
    const job = st.jobs.find((j) => j.id === id);
    return job && ENDED.has(job.status) ? job : null;
  };
  return new Promise((resolve) => {
    const now = ended(jobs.getState());
    if (now) {
      resolve(now);
      return;
    }
    const stop = jobs.subscribe((st) => {
      const job = ended(st);
      if (!job) return;
      stop();
      resolve(job);
    });
  });
}

/** Start a pipeline job on the open project and wait for it; an error sentence or null. */
async function run(
  pipeline: PipelineName,
  params: Record<string, unknown>,
): Promise<string | null> {
  const root = get().root;
  if (!root) return 'No project is open.';
  await jobs.getState().init();
  const err = await jobs.getState().start({ pipeline, project: root, params });
  if (err) return err;
  const id = jobs.getState().selected;
  if (!id) return 'The job did not start.';
  const job = await waitForJob(id);
  if (job.status === 'done') return null;
  return job.error ?? `The job ended: ${job.status}.`;
}

const RANK: Record<string, number> = { dsm: 1, cloud: 2, dtm: 3 };

/** The prepared surface of a survey (DSM first, then a cloud, then a DTM), or null. */
export function surfaceOfCapture(
  surfaces: readonly HeightTiles[],
  capture: string,
): HeightTiles | null {
  let best: HeightTiles | null = null;
  for (const s of surfaces) {
    if (s.capture !== capture) continue;
    const r = RANK[s.source.kind] ?? 9;
    if (
      !best ||
      r < (RANK[best.source.kind] ?? 9) ||
      (r === RANK[best.source.kind] && s.id < best.id)
    )
      best = s;
  }
  return best;
}

/** The surface source of a survey's own data: its DSM raster, else its point cloud. */
export function sourceOfCapture(
  manifest: ProjectManifest,
  capture: string,
): { kind: 'dsm' | 'cloud'; layer: string } | null {
  const dsm = manifest.layers.find(
    (l) => l.kind === 'raster' && l.role === 'dsm' && l.capture === capture,
  );
  if (dsm) return { kind: 'dsm', layer: dsm.id };
  const cloud = manifest.layers.find((l) => l.kind === 'pointcloud' && l.capture === capture);
  return cloud ? { kind: 'cloud', layer: cloud.id } : null;
}

/** The id of the survey's prepared surface, preparing it first when it has none. */
async function ensureSurface(
  manifest: ProjectManifest,
  capture: string,
): Promise<{ id: string } | { error: string }> {
  const have = surfaceOfCapture(get().surfaces, capture);
  if (have) return { id: have.id };
  const source = sourceOfCapture(manifest, capture);
  const label = manifest.captures.find((c) => c.id === capture)?.label ?? capture;
  if (!source) return { error: `${label} has no DSM or point cloud to check.` };
  set({ busy: `Preparing the surface of ${label}` });
  const id = `${source.kind}-${capture}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  const err = await run('survey.prepare', {
    surfaces: [
      { id, name: `${source.kind === 'dsm' ? 'DSM' : 'Cloud'} ${label}`, source, capture },
    ],
  });
  if (err) return { error: err };
  await refreshQa();
  return { id };
}

/** Prepare a survey's surface (its DSM, else its cloud) for cleanups, crops and checks. */
export async function prepareCapture(manifest: ProjectManifest, capture: string): Promise<void> {
  if (get().busy) return;
  set({ message: null });
  try {
    const r = await ensureSurface(manifest, capture);
    if ('error' in r) set({ message: { kind: 'error', text: r.error } });
  } finally {
    set({ busy: null });
  }
}

export type Checkpoints = { csv: string } | { gcp: string } | null;

/** **Check against points** (and against the previous survey) at `level`. */
export async function runQa(
  manifest: ProjectManifest,
  capture: string,
  level: QaLevel,
  checkpoints: Checkpoints,
): Promise<void> {
  if (get().busy) return;
  set({ message: null });
  try {
    const surface = await ensureSurface(manifest, capture);
    if ('error' in surface) {
      set({ message: { kind: 'error', text: surface.error } });
      return;
    }
    // the survey before it (by date), prepared too, for the compare-to-previous check
    const dated = [...manifest.captures].sort((a, b) => a.date.localeCompare(b.date));
    const at = dated.findIndex((c) => c.id === capture);
    const before = dated
      .slice(0, Math.max(0, at))
      .reverse()
      .find((c) => sourceOfCapture(manifest, c.id) !== null);
    if (before) await ensureSurface(manifest, before.id);
    set({ busy: 'Checking the survey' });
    const err = await run('survey.qa', {
      capture,
      surface: surface.id,
      level,
      ...(checkpoints ? { checkpoints } : {}),
    });
    await refreshQa();
    set({ message: err ? { kind: 'error', text: err } : null });
  } finally {
    set({ busy: null });
  }
}

/** Release a survey on hold with a person's note. */
export async function releaseHold(capture: string, note: string): Promise<string | null> {
  const projectId = get().projectId;
  if (!projectId) return 'No project is open.';
  const r = await bridge.call('survey:releaseHold', { projectId, capture, note });
  const err = !r.ok ? r.error : r.value.ok ? null : r.value.error;
  if (err) {
    set({ message: { kind: 'error', text: err } });
    return err;
  }
  if (r.ok && r.value.ok) set({ qa: { ...get().qa, [capture]: r.value.qa }, message: null });
  return null;
}

// ---------------------------------------------------------------- terrain edits

async function saveEdits(next: TerrainEditsFile): Promise<string | null> {
  const projectId = get().projectId;
  if (!projectId) return 'No project is open.';
  const r = await bridge.call('survey:writeTerrainEdits', { projectId, file: next });
  const err = !r.ok ? r.error : r.value.ok ? null : r.value.error;
  if (err) set({ message: { kind: 'error', text: err } });
  else set({ edits: next });
  return err;
}

let editCounter = 0;
/** A new file-name-safe edit id. */
export function newEditId(kind: TerrainEdit['kind']): string {
  editCounter = (editCounter + 1) % 1296;
  return `${kind}-${Date.now().toString(36)}${editCounter.toString(36).padStart(2, '0')}`;
}

export function addEdit(edit: TerrainEdit): Promise<string | null> {
  const cur = get().edits;
  return saveEdits({ ...cur, edits: [...cur.edits, edit] });
}

export function patchEdit(id: string, patch: Partial<TerrainEdit>): Promise<string | null> {
  const cur = get().edits;
  return saveEdits({
    ...cur,
    edits: cur.edits.map((e) => (e.id === id ? { ...e, ...patch } : e)),
  });
}

/** Run the cleanups and crops of a surface (enabled ones, in order) into its cleaned surface. */
export async function runCleanup(surface: string): Promise<void> {
  if (get().busy) return;
  const ids = get()
    .edits.edits.filter((e) => e.surface === surface)
    .map((e) => e.id);
  if (ids.length === 0) {
    set({ message: { kind: 'error', text: 'This surface has no cleanups or crops yet.' } });
    return;
  }
  set({ busy: 'Cleaning the surface', message: null });
  try {
    const err = await run('survey.cleanup', { surface, edits: ids });
    await refreshQa();
    const meta = get().surfaces.find((s) => s.id === surface);
    const out = `${meta?.capture ?? surface}-clean`;
    set({
      message: err
        ? { kind: 'error', text: err }
        : {
            kind: 'ok',
            text: `The cleaned surface "${out}" is ready; pick it in a comparison to use it.`,
          },
    });
  } finally {
    set({ busy: null });
  }
}

// ------------------------------------------------------------------------------------ DTM filter

export type DtmPreset = 'equipment' | 'equipment-vegetation' | 'structures' | 'everything';

/** The DTM filter presets of `survey.cleanup` (PDAL smrf or csf), with what each removes. */
export const DTM_PRESETS: { id: DtmPreset; label: string; hint: string }[] = [
  { id: 'equipment', label: 'Equipment', hint: 'Parked plant and other small objects' },
  {
    id: 'equipment-vegetation',
    label: 'Equipment and vegetation',
    hint: 'Plant, bushes and trees',
  },
  { id: 'structures', label: 'Structures', hint: 'Buildings and other large objects as well' },
  { id: 'everything', label: 'Everything above the ground', hint: 'Cloth simulation (CSF)' },
];

/** What the pipeline pack offers here (`app:setupStatus`), for the DTM filter. */
export interface PipelineTools {
  found: boolean;
  pdal?: boolean | undefined;
}

/** The point cloud layers of a project, the sources of a DTM filter. */
export function cloudLayers(
  manifest: Pick<ProjectManifest, 'layers'>,
): { id: string; name: string; capture?: string }[] {
  return manifest.layers
    .filter((l) => l.kind === 'pointcloud')
    .map((l) => ({ id: l.id, name: l.name, ...(l.capture ? { capture: l.capture } : {}) }));
}

/** Why the DTM filter cannot run here (no cloud layer, no pipeline pack, no PDAL), or null. */
export function dtmFilterBlock(
  manifest: Pick<ProjectManifest, 'layers'>,
  tools: PipelineTools | null,
): string | null {
  if (cloudLayers(manifest).length === 0)
    return 'The DTM filter works on a point cloud, and this project has none.';
  if (!tools) return 'Checking the pipeline pack…';
  if (!tools.found) return 'The DTM filter runs in the pipeline pack, which is not installed.';
  if (tools.pdal === false)
    return 'The DTM filter runs in PDAL, which the pipeline pack here does not have. Install the full pipeline pack.';
  return null;
}

/** A DTM from a cloud layer with a filter preset, as a new prepared surface `<capture>-dtm`. */
export async function runDtmFilter(layer: string, preset: DtmPreset): Promise<void> {
  if (get().busy || get().readOnly) return;
  set({ busy: 'Filtering the ground', message: null });
  try {
    const err = await run('survey.cleanup', { dtmFilter: { layer, preset } });
    await refreshQa();
    set({
      message: err
        ? { kind: 'error', text: err }
        : {
            kind: 'ok',
            text: 'The DTM is ready as a new surface; pick it in a comparison to use it.',
          },
    });
  } finally {
    set({ busy: null });
  }
}

/** For tests: back to an empty store. */
export function resetQa(): void {
  set({
    projectId: null,
    root: null,
    readOnly: false,
    qa: {},
    surfaces: [],
    edits: emptyEdits(),
    panel: null,
    busy: null,
    message: null,
  });
}
