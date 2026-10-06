import {
  pipelineParams,
  type AioBridge,
  type Issue,
  type IpcRequest,
  type JobEvent,
  type JobLogLine,
  type JobRecord,
  type PipelineName,
  type RuntimeInfo,
} from '@aio/schema';
import { t } from '@aio/ui';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Bridge } from './bridge';

const LOG_KEEP = 2000;

/** A new job form filled in elsewhere (the road setup panel), opened by the Jobs screen. */
export interface JobDraft {
  pipeline: PipelineName;
  project: string;
  values: Record<string, string>;
}

export interface JobsState {
  /** null until the first jobs:list answer. */
  runtime: RuntimeInfo | null;
  /** Newest first. */
  jobs: JobRecord[];
  logs: Record<string, JobLogLine[]>;
  selected: string | null;
  error: string | null;
  draft: JobDraft | null;
}

export interface JobsActions {
  /** Load the list and follow jobs:event. Safe to call more than once. */
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  /** Start a job; returns an error sentence or null. */
  start: (req: IpcRequest<'jobs:start'>) => Promise<string | null>;
  cancel: (id: string) => Promise<string | null>;
  open: (id: string, what: 'output' | 'log' | 'project') => Promise<string | null>;
  /** Fill in a new job form for the Jobs screen (null clears it). */
  prepare: (draft: JobDraft | null) => void;
}

export type Jobs = JobsState & JobsActions;

/** Fold one pushed event into the list and logs (pure, for tests). */
export function applyJobEvent(
  s: Pick<JobsState, 'jobs' | 'logs'>,
  e: JobEvent,
): Pick<JobsState, 'jobs' | 'logs'> {
  if (e.type === 'update') {
    const i = s.jobs.findIndex((j) => j.id === e.job.id);
    // An invoke answer can arrive after newer pushed events; never go back in time.
    const known = s.jobs[i];
    if (known && known.updatedAt > e.job.updatedAt) return s;
    const jobs = i < 0 ? [e.job, ...s.jobs] : s.jobs.map((j, k) => (k === i ? e.job : j));
    return { jobs, logs: s.logs };
  }
  const prev = s.logs[e.jobId] ?? [];
  const next = prev.length >= LOG_KEEP ? [...prev.slice(-LOG_KEEP + 1), e.line] : [...prev, e.line];
  return { jobs: s.jobs, logs: { ...s.logs, [e.jobId]: next } };
}

/** Pipelines that add layers to the project manifest when they finish. */
const MANIFEST_WRITERS: ReadonlySet<string> = new Set([
  'pointcloud.to_copc',
  'volumetric.build',
  'road.build',
]);
/** Pipelines that also write issues.json (and road.json): the open project reopens whole. */
const PROJECT_WRITERS: ReadonlySet<string> = new Set(['road.build']);

const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const sameFolder = (a: string, b: string) => folderKey(a) === folderKey(b);

function justFinished(
  prev: readonly JobRecord[],
  next: readonly JobRecord[],
  root: string,
  pipelines: ReadonlySet<string>,
): boolean {
  return next.some(
    (j) =>
      j.status === 'done' &&
      pipelines.has(j.pipeline) &&
      sameFolder(j.project, root) &&
      prev.find((p) => p.id === j.id)?.status !== 'done',
  );
}

/**
 * True when a job that writes the manifest of the project at `root` has just finished: the open
 * project should reload its manifest (a converted point cloud appears as a layer).
 */
export function finishedManifestJob(
  prev: readonly JobRecord[],
  next: readonly JobRecord[],
  root: string,
): boolean {
  return justFinished(prev, next, root, MANIFEST_WRITERS);
}

/**
 * True when a job that rewrites the project's issues (the road builder) has just finished: the
 * open project should reload its manifest and its issues.
 */
export function finishedProjectJob(
  prev: readonly JobRecord[],
  next: readonly JobRecord[],
  root: string,
): boolean {
  return justFinished(prev, next, root, PROJECT_WRITERS);
}

/** Pipelines that merge issues into the project's issues.json when they finish. */
const ISSUE_WRITERS: ReadonlySet<string> = new Set(['inspection.run']);

/**
 * True when a job that writes the issues of the project at `root` has just finished: the open
 * project should take the merged issues from disk (inspection pipeline).
 */
export function finishedIssuesJob(
  prev: readonly JobRecord[],
  next: readonly JobRecord[],
  root: string,
): boolean {
  return next.some(
    (j) =>
      j.status === 'done' &&
      ISSUE_WRITERS.has(j.pipeline) &&
      sameFolder(j.project, root) &&
      prev.find((p) => p.id === j.id)?.status !== 'done',
  );
}

/**
 * The open project's issues after a pipeline merged issues.json on disk: the disk list, except
 * where the person changed an issue in the app since (newer `updatedAt`) or made one that is not
 * saved yet. Returns the list and whether it holds unsaved work to write back.
 */
export function mergeDiskIssues(
  open: readonly Issue[],
  disk: readonly Issue[],
): { issues: Issue[]; unsaved: boolean } {
  const local = new Map(open.map((i) => [i.id, i]));
  let unsaved = false;
  const issues = disk.map((d) => {
    const mine = local.get(d.id);
    if (mine && mine.updatedAt > d.updatedAt) {
      unsaved = true;
      return mine;
    }
    return d;
  });
  const onDisk = new Set(disk.map((i) => i.id));
  for (const i of open)
    if (!onDisk.has(i.id)) {
      issues.push(i);
      unsaved = true;
    }
  return { issues, unsaved };
}

/**
 * Jobs that finished or failed between two lists (both known before, so the first load of the
 * job history says nothing), for the screen reader announcement.
 */
export function jobsEnded(
  prev: readonly JobRecord[],
  next: readonly JobRecord[],
): { job: JobRecord; ok: boolean }[] {
  return next
    .filter((j) => {
      if (j.status !== 'done' && j.status !== 'failed') return false;
      const before = prev.find((p) => p.id === j.id);
      return before !== undefined && before.status !== j.status;
    })
    .map((job) => ({ job, ok: job.status === 'done' }));
}

export function isActive(job: Pick<JobRecord, 'status'>): boolean {
  return job.status === 'starting' || job.status === 'running' || job.status === 'cancelling';
}

export function canResume(job: Pick<JobRecord, 'status'>): boolean {
  return job.status === 'failed' || job.status === 'cancelled' || job.status === 'interrupted';
}

export function createJobsStore(bridge: Bridge, on: AioBridge['on'] | undefined): StoreApi<Jobs> {
  let following = false;
  return createStore<Jobs>()((set, get) => ({
    runtime: null,
    jobs: [],
    logs: {},
    selected: null,
    error: null,
    draft: null,

    prepare: (draft) => {
      set({ draft });
    },

    init: async () => {
      if (!following && on) {
        following = true;
        on('jobs:event', (e) => {
          set((s) => applyJobEvent(s, e));
        });
      }
      await get().refresh();
    },

    refresh: async () => {
      const r = await bridge.call('jobs:list', {});
      if (!r.ok) {
        set({ error: r.error });
        return;
      }
      set((s) => ({
        runtime: r.value.runtime,
        jobs: r.value.jobs,
        error: null,
        selected: s.selected ?? r.value.jobs[0]?.id ?? null,
      }));
      const sel = get().selected;
      if (sel && !get().logs[sel]) await get().select(sel);
    },

    select: async (id) => {
      set({ selected: id });
      if (!id) return;
      const r = await bridge.call('jobs:log', { jobId: id, tail: 1000 });
      if (r.ok) set((s) => ({ logs: { ...s.logs, [id]: mergeLog(r.value.lines, s.logs[id]) } }));
    },

    start: async (req) => {
      const r = await bridge.call('jobs:start', req);
      if (!r.ok) return r.error;
      if (!r.value.ok) return r.value.error;
      const job = r.value.job;
      set((s) => ({
        ...applyJobEvent(s, { type: 'update', job }),
        selected: job.id,
        logs: 'resume' in req ? s.logs : { ...s.logs, [job.id]: s.logs[job.id] ?? [] },
      }));
      return null;
    },

    cancel: async (id) => {
      const r = await bridge.call('jobs:cancel', { jobId: id });
      if (!r.ok) return r.error;
      return r.value.ok ? null : (r.value.error ?? 'The job could not be cancelled.');
    },

    open: async (id, what) => {
      const r = await bridge.call('jobs:open', { jobId: id, what });
      if (!r.ok) return r.error;
      return r.value.ok ? null : (r.value.error ?? 'Nothing to open.');
    },
  }));
}

/** History from main, plus any live lines that arrived while it was loading. */
function mergeLog(history: JobLogLine[], live: JobLogLine[] | undefined): JobLogLine[] {
  if (!live?.length) return history;
  const last = history.at(-1);
  const from = last ? live.findIndex((l) => l.time > last.time) : 0;
  return from < 0 ? history : [...history, ...live.slice(from)];
}

// ---------------------------------------------------------------- new job forms

export interface Field {
  key: string;
  label: string;
  /** `file` picks one file, `files` one or more (separated by `;`, sent as a list when several). */
  kind: 'folder' | 'file' | 'files' | 'text' | 'number' | 'origin' | 'select';
  /** A select whose values are 'true' / 'false' sends a boolean. */
  boolean?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  /** File types offered by the Choose button of a `file` or `files` field. */
  filters?: { name: string; extensions: string[] }[];
}

const GEO_FILES = ['geojson', 'json', 'kml', 'dxf', 'shp', 'js'];

export const FORMS: Record<PipelineName, Field[]> = {
  'aik.cameras': [
    {
      key: 'photos',
      label: 'Original photos',
      kind: 'folder',
      required: true,
      help: 'Read only. Subfolders become flights.',
    },
    {
      key: 'origin',
      label: 'Asset base',
      kind: 'origin',
      placeholder: 'Latitude, longitude, ground altitude (m)',
      help: 'Leave empty to use the mean photo position.',
    },
    { key: 'assetHeight', label: 'Asset height (m)', kind: 'number', placeholder: 'Optional' },
    { key: 'longEdge', label: 'Review copy long edge (px)', kind: 'number', placeholder: '2560' },
    { key: 'out', label: 'Cameras file', kind: 'text', placeholder: 'cameras.json' },
    { key: 'photosOut', label: 'Review copies folder', kind: 'text', placeholder: 'photos' },
  ],
  'aik.project': [
    { key: 'job', label: 'Kit job file', kind: 'text', placeholder: 'job.yaml' },
    {
      key: 'placement',
      label: 'Placement',
      kind: 'select',
      options: [
        { value: '', label: 'As the profile says' },
        { value: 'point', label: 'Pins' },
        { value: 'patch', label: 'Patches' },
      ],
    },
    { key: 'grid', label: 'Ray grid', kind: 'number', placeholder: '48' },
    { key: 'out', label: 'Surface file', kind: 'text', placeholder: 'surface.json' },
  ],
  'aik.records': [
    { key: 'job', label: 'Kit job file', kind: 'text', placeholder: 'job.yaml' },
    { key: 'out', label: 'Records file', kind: 'text', placeholder: 'records.json' },
    { key: 'csv', label: 'Findings CSV', kind: 'text', placeholder: 'findings.csv' },
  ],
  'volumetric.process': [
    { key: 'job', label: 'Survey job file', kind: 'text', placeholder: 'job.json' },
    { key: 'out', label: 'Piles file', kind: 'text', placeholder: 'piles.json' },
  ],
  'volumetric.build': [
    {
      key: 'job',
      label: 'Survey job file',
      kind: 'text',
      placeholder: 'volumetric/job.json',
      help: 'Written by the first build from the new project wizard. Edit its detect block, then run again.',
    },
  ],
  'pointcloud.to_copc': [
    {
      key: 'src',
      label: 'Point cloud file',
      kind: 'text',
      required: true,
      placeholder: 'D:/scans/site.laz',
      help: 'LAS, LAZ, E57 or PLY. Read only.',
    },
    { key: 'epsg', label: 'Project EPSG', kind: 'number', placeholder: 'From the project' },
    { key: 'out', label: 'COPC file', kind: 'text', placeholder: 'clouds/<name>.copc.laz' },
  ],
  'inspection.run': [
    {
      key: 'detections',
      label: t('jobs.inspection.detections'),
      kind: 'text',
      placeholder: 'detections',
      help: t('jobs.inspection.detectionsHelp'),
    },
    {
      key: 'includeDrafts',
      label: t('jobs.inspection.drafts'),
      kind: 'select',
      boolean: true,
      options: [
        { value: '', label: t('jobs.inspection.draftsLeaveOut') },
        { value: 'true', label: t('jobs.inspection.draftsCount') },
      ],
    },
    {
      key: 'minConfidence',
      label: t('jobs.inspection.minConfidence'),
      kind: 'number',
      placeholder: t('jobs.inspection.minConfidenceHint'),
    },
    {
      key: 'clusterM',
      label: t('jobs.inspection.clusterM'),
      kind: 'number',
      placeholder: t('jobs.inspection.clusterMHint'),
    },
    {
      key: 'hfovDeg',
      label: t('jobs.inspection.hfovDeg'),
      kind: 'number',
      placeholder: '70',
      help: t('jobs.inspection.hfovDegHelp'),
    },
    {
      key: 'out',
      label: t('jobs.inspection.out'),
      kind: 'text',
      placeholder: 'inspection',
    },
  ],
  'road.build': [
    {
      key: 'centreline',
      label: t('jobs.road.centreline'),
      kind: 'file',
      required: true,
      placeholder: 'road/centreline-drawn.geojson',
      help: t('jobs.road.centrelineHelp'),
      filters: [{ name: t('jobs.road.filterGeo'), extensions: GEO_FILES }],
    },
    {
      key: 'ortho',
      label: t('jobs.road.ortho'),
      kind: 'files',
      placeholder: 'D:/survey/ortho.tif',
      help: t('jobs.road.orthoHelp'),
      filters: [{ name: t('jobs.road.filterRaster'), extensions: ['tif', 'tiff'] }],
    },
    {
      key: 'defects',
      label: t('jobs.road.defects'),
      kind: 'file',
      placeholder: 'D:/survey/defects.geojson',
      help: t('jobs.road.defectsHelp'),
      filters: [{ name: t('jobs.road.filterGeo'), extensions: GEO_FILES }],
    },
    {
      key: 'units',
      label: t('jobs.road.units'),
      kind: 'select',
      options: [
        { value: '', label: t('jobs.road.unitsChainage') },
        { value: 'grid', label: t('jobs.road.unitsGrid') },
      ],
    },
    {
      key: 'unitLength',
      label: t('jobs.road.unitLength'),
      kind: 'number',
      placeholder: '31',
      help: t('jobs.road.unitLengthHelp'),
    },
    { key: 'lanes', label: t('jobs.road.lanes'), kind: 'number', placeholder: '2' },
    { key: 'laneWidth', label: t('jobs.road.laneWidth'), kind: 'number', placeholder: '3.65' },
    {
      key: 'pavement',
      label: t('jobs.road.pavement'),
      kind: 'file',
      help: t('jobs.road.pavementHelp'),
      filters: [{ name: t('jobs.road.filterRaster'), extensions: ['tif', 'tiff'] }],
    },
    {
      key: 'orthoCm',
      label: t('jobs.road.orthoCm'),
      kind: 'number',
      placeholder: t('jobs.road.orthoCmPlaceholder'),
    },
    { key: 'centrelineEpsg', label: t('jobs.road.centrelineEpsg'), kind: 'number' },
  ],
  'system.selftest': [
    {
      key: 'seconds',
      label: 'Wait (s)',
      kind: 'number',
      placeholder: '0',
      help: 'A wait step to try cancel and resume.',
    },
  ],
  // M8: these run from the Changes panel and the Model builder, which fill every parameter; the
  // forms here cover the flat parameters for a manual run.
  'change.raster': [
    { key: 'from', label: 'Earlier capture id', kind: 'text', required: true },
    { key: 'to', label: 'Later capture id', kind: 'text', required: true },
    { key: 'layerFrom', label: 'Earlier ortho layer id', kind: 'text', required: true },
    { key: 'layerTo', label: 'Later ortho layer id', kind: 'text', required: true },
    {
      key: 'method',
      label: 'Method',
      kind: 'select',
      required: true,
      options: [
        { value: 'gradient', label: 'Gradient (robust to light)' },
        { value: 'ssim', label: 'Structural similarity' },
        { value: 'rgb', label: 'Colour difference' },
      ],
    },
    { key: 'minAreaM2', label: 'Smallest area (m²)', kind: 'number', placeholder: '1' },
    { key: 'maxShiftPx', label: 'Largest shift (px)', kind: 'number', placeholder: '2' },
  ],
  'change.surface': [],
  'change.cloud': [
    { key: 'layerFrom', label: 'Earlier point cloud layer id', kind: 'text', required: true },
    { key: 'layerTo', label: 'Later point cloud layer id', kind: 'text', required: true },
    { key: 'minDistM', label: 'Significant from (m)', kind: 'number', placeholder: '0.05' },
    { key: 'maxDistM', label: 'Far from (m)', kind: 'number', placeholder: '0.30' },
  ],
  'change.mesh': [
    { key: 'layerFrom', label: 'Earlier model layer id', kind: 'text', required: true },
    { key: 'layerTo', label: 'Later model layer id', kind: 'text', required: true },
    { key: 'samples', label: 'Sample points', kind: 'number', placeholder: '1000000' },
  ],
  'change.frames': [
    { key: 'from', label: 'Earlier capture id', kind: 'text', required: true },
    { key: 'to', label: 'Later capture id', kind: 'text', required: true },
    { key: 'maxPoseM', label: 'Largest camera distance (m)', kind: 'number', placeholder: '10' },
    { key: 'maxAngleDeg', label: 'Largest view angle (°)', kind: 'number', placeholder: '15' },
    { key: 'minAreaPx', label: 'Smallest change (pixels)', kind: 'number', placeholder: '400' },
  ],
  'drawing.import': [
    {
      key: 'src',
      label: 'Drawing (DXF)',
      kind: 'file',
      required: true,
      help: 'Read only. DWG is not supported: save as DXF first.',
      filters: [{ name: 'DXF drawing', extensions: ['dxf'] }],
    },
    {
      key: 'units',
      label: 'Drawing units',
      kind: 'select',
      options: [
        { value: '', label: 'As the file says' },
        { value: 'mm', label: 'Millimetres' },
        { value: 'cm', label: 'Centimetres' },
        { value: 'm', label: 'Metres' },
        { value: 'in', label: 'Inches' },
        { value: 'ft', label: 'Feet' },
        { value: 'us-ft', label: 'US survey feet' },
      ],
    },
  ],
  'model.fit_cloud': [
    { key: 'layer', label: 'Point cloud layer id', kind: 'text', required: true },
    { key: 'distM', label: 'Fit distance (m)', kind: 'number', placeholder: '0.05' },
    { key: 'model', label: 'Add to model id', kind: 'text', placeholder: 'A new model' },
  ],
};

/** Turn the form's text values into checked params, or say what is wrong. */
export function buildParams(
  pipeline: PipelineName,
  values: Record<string, string>,
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const params: Record<string, unknown> = {};
  for (const f of FORMS[pipeline]) {
    const raw = (values[f.key] ?? '').trim();
    if (!raw) {
      if (f.required) return { ok: false, error: `${f.label} is required.` };
      continue;
    }
    if (f.kind === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `${f.label} must be a number.` };
      params[f.key] = n;
    } else if (f.kind === 'origin') {
      const parts = raw
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number);
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
        return { ok: false, error: `${f.label}: give latitude, longitude and ground altitude.` };
      }
      params[f.key] = parts;
    } else if (f.boolean) {
      params[f.key] = raw === 'true';
    } else if (f.kind === 'files') {
      const list = raw
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      params[f.key] = list.length === 1 ? list[0] : list;
    } else {
      params[f.key] = raw;
    }
  }
  const r = pipelineParams(pipeline).safeParse(params);
  if (!r.success) {
    const first = r.error.issues[0];
    const field = FORMS[pipeline].find((f) => f.key === first?.path[0]);
    return { ok: false, error: `${field?.label ?? 'A value'}: ${first?.message ?? 'not valid'}` };
  }
  return { ok: true, params: r.data };
}
