import {
  pipelineParams,
  type AioBridge,
  type IpcRequest,
  type JobEvent,
  type JobLogLine,
  type JobRecord,
  type PipelineName,
  type RuntimeInfo,
} from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Bridge } from './bridge';

const LOG_KEEP = 2000;

export interface JobsState {
  /** null until the first jobs:list answer. */
  runtime: RuntimeInfo | null;
  /** Newest first. */
  jobs: JobRecord[];
  logs: Record<string, JobLogLine[]>;
  selected: string | null;
  error: string | null;
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
}

export type Jobs = JobsState & JobsActions;

/** Fold one pushed event into the list and logs (pure, for tests). */
export function applyJobEvent(
  s: Pick<JobsState, 'jobs' | 'logs'>,
  e: JobEvent,
): Pick<JobsState, 'jobs' | 'logs'> {
  if (e.type === 'update') {
    const i = s.jobs.findIndex((j) => j.id === e.job.id);
    const jobs = i < 0 ? [e.job, ...s.jobs] : s.jobs.map((j, k) => (k === i ? e.job : j));
    return { jobs, logs: s.logs };
  }
  const prev = s.logs[e.jobId] ?? [];
  const next = prev.length >= LOG_KEEP ? [...prev.slice(-LOG_KEEP + 1), e.line] : [...prev, e.line];
  return { jobs: s.jobs, logs: { ...s.logs, [e.jobId]: next } };
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
  kind: 'folder' | 'text' | 'number' | 'origin' | 'select';
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

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
  'system.selftest': [
    {
      key: 'seconds',
      label: 'Wait (s)',
      kind: 'number',
      placeholder: '0',
      help: 'A wait step to try cancel and resume.',
    },
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
