/**
 * Telecom antenna inventory in the renderer: the project's `telecom/antennas.json`, the
 * `telecom.antennas` job, review (accept / reject), the fields a person types, the selection and
 * the merge of AI labels. Each review change is written at once. AI labels change only `kind`,
 * `kindBasis` and `ai`, never a number.
 */
import {
  AI_LABEL_KIND,
  TOWER_HINT_NEEDED,
  type AntennasFile,
  type AntennaStatus,
  type AntennaUserFields,
  type IpcResponse,
  type JobRecord,
} from '@aio/schema';
import { createStore, useStore } from 'zustand';
import { bridge, jobs } from '../shell';

export interface AntennaState {
  projectId: string | null;
  root: string | null;
  file: AntennasFile | null;
  readOnly: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  message: string | null;
  jobId: string | null;
  running: boolean;
  needsHint: boolean;
  selected: string | null;
  hidden: Record<string, true>;
  /** null = automatic (the newest visible cloud). */
  cloudLayer: string | null;
}

const initial = (): AntennaState => ({
  projectId: null,
  root: null,
  file: null,
  readOnly: false,
  status: 'idle',
  message: null,
  jobId: null,
  running: false,
  needsHint: false,
  selected: null,
  hidden: {},
  cloudLayer: null,
});

export const antennaStore = createStore<AntennaState>()(initial);

export function useAntennas<T>(selector: (s: AntennaState) => T): T {
  return useStore(antennaStore, selector);
}

const set = (patch: Partial<AntennaState>) => {
  antennaStore.setState(patch);
};
const get = () => antennaStore.getState();

/** Guards a slow read against a newer load or a project switch. */
let loadSeq = 0;
/** Writes run one after the other so a quick second click builds on the first. */
let queue: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------- loading

/**
 * Read the project's antenna file. Safe to call again for the same project (reloads) and when the
 * project changes (the old inventory, selection and run are dropped).
 */
export async function loadAntennas(projectId: string, root: string): Promise<void> {
  watchJobs();
  const seq = ++loadSeq;
  const same = get().projectId === projectId && get().root === root;
  if (same) set({ status: get().file ? get().status : 'loading' });
  else set({ ...initial(), projectId, root, status: 'loading' });
  const r = await bridge.call('telecom:readAntennas', { projectId });
  if (seq !== loadSeq || get().projectId !== projectId) return;
  if (!r.ok || !r.value.ok) {
    const error = !r.ok ? r.error : r.value.ok ? '' : r.value.error;
    set({ status: 'error', message: error });
    return;
  }
  const file = r.value.file;
  const ids = new Set(file?.units.map((u) => u.id));
  const { selected, hidden } = get();
  set({
    status: 'ready',
    file,
    readOnly: r.value.readOnly,
    message: null,
    selected: selected && ids.has(selected) ? selected : null,
    hidden: Object.fromEntries(
      Object.keys(hidden)
        .filter((id) => ids.has(id))
        .map((id) => [id, true as const]),
    ),
  });
}

// ---------------------------------------------------------------- the job

let watching = false;
function watchJobs(): void {
  // tests of other components mock the jobs store with a stub
  const store: Partial<typeof jobs> = jobs;
  if (watching || !store.subscribe) return;
  watching = true;
  store.subscribe((s) => {
    onJobs(s.jobs);
  });
}

function onJobs(list: readonly JobRecord[]): void {
  const { jobId, running } = get();
  if (!jobId || !running) return;
  const job = list.find((j) => j.id === jobId);
  if (!job) return;
  switch (job.status) {
    case 'done': {
      const { projectId, root } = get();
      set({ running: false, jobId: null, needsHint: false, message: null });
      if (projectId && root) void loadAntennas(projectId, root);
      return;
    }
    case 'failed': {
      const error = job.error ?? '';
      if (error.includes(TOWER_HINT_NEEDED))
        set({ running: false, jobId: null, needsHint: true, message: null });
      else set({ running: false, jobId: null, needsHint: false, message: error || null });
      return;
    }
    case 'cancelled':
    case 'interrupted':
      set({ running: false, jobId: null });
      return;
    default:
      return;
  }
}

const newRunId = (): string =>
  `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Start `telecom.antennas`; a second call while a run is going is ignored. */
export async function runDetection(opts?: { towerHint?: [number, number] }): Promise<void> {
  const s = get();
  if (s.running || s.readOnly || !s.root) return;
  watchJobs();
  const params: Record<string, unknown> = { run: newRunId() };
  if (s.cloudLayer) params.cloud = { layer: s.cloudLayer };
  if (opts?.towerHint) params.towerHint = opts.towerHint;
  const root = s.root;
  set({ running: true, needsHint: false, message: null });
  const r = await bridge.call('jobs:start', {
    pipeline: 'telecom.antennas',
    project: root,
    params,
  });
  if (get().root !== root) return;
  if (!r.ok || !r.value.ok) {
    const error = !r.ok ? r.error : r.value.ok ? '' : r.value.error;
    set({ running: false, jobId: null, message: error });
    return;
  }
  set({ jobId: r.value.job.id });
  // the job may already have finished by the time the answer arrives
  const store: Partial<typeof jobs> = jobs;
  if (store.getState) onJobs(store.getState().jobs);
}

/** Drop the "click the tower" request. */
export function cancelHint(): void {
  set({ needsHint: false });
}

export function setCloudLayer(id: string | null): void {
  set({ cloudLayer: id });
}

// ---------------------------------------------------------------- review

/**
 * Change the file and write it. The change is made on the file as it is when its turn comes; a
 * refused write (a newer file on disk) reloads and says so.
 */
function change(edit: (file: AntennasFile) => AntennasFile | null): Promise<void> {
  const next = queue.then(async () => {
    const { file, projectId, root, readOnly } = get();
    if (!file || !projectId || !root || readOnly) return;
    const updated = edit(file);
    if (!updated) return;
    const r = await bridge.call('telecom:writeAntennas', { projectId, file: updated });
    if (get().projectId !== projectId) return;
    if (r.ok && r.value.ok) {
      set({ file: updated, message: null });
      return;
    }
    const error = !r.ok ? r.error : r.value.ok ? '' : r.value.error;
    await loadAntennas(projectId, root);
    set({ message: error || 'The antenna file changed on disk. It was loaded again.' });
  });
  queue = next.catch(() => undefined);
  return next;
}

export function setUnitStatus(id: string, status: AntennaStatus): Promise<void> {
  return change((file) =>
    file.units.some((u) => u.id === id)
      ? { ...file, units: file.units.map((u) => (u.id === id ? { ...u, status } : u)) }
      : null,
  );
}

/** Set the typed fields; an explicitly undefined field is cleared. */
export function patchUnitUser(id: string, fields: AntennaUserFields): Promise<void> {
  return change((file) => {
    if (!file.units.some((u) => u.id === id)) return null;
    return {
      ...file,
      units: file.units.map((u) => {
        if (u.id !== id) return u;
        const merged: Record<string, unknown> = { ...u.user, ...fields };
        const user = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
        return { ...u, user };
      }),
    };
  });
}

export function selectAntenna(id: string | null): void {
  set({ selected: id });
}

export function toggleAntennaHidden(id: string): void {
  const { hidden } = get();
  if (hidden[id])
    set({ hidden: Object.fromEntries(Object.entries(hidden).filter(([k]) => k !== id)) });
  else set({ hidden: { ...hidden, [id]: true } });
}

// ---------------------------------------------------------------- AI labels

/**
 * Merge AI labels into the file. Only `kind`, `kindBasis` and `ai` of a unit change; a kind a
 * person set stays. The run's AI usage is recorded on the run.
 */
export function applyAiLabels(
  res: Extract<IpcResponse<'ai:labelAntennas'>, { ok: true }>,
  runId: string,
): Promise<void> {
  return change((file) => {
    const byId = new Map(res.labels.map((l) => [l.unitId, l]));
    let applied = 0;
    const units = file.units.map((u) => {
      const label = byId.get(u.id);
      if (!label || u.kindBasis === 'user') return u;
      applied++;
      return {
        ...u,
        kind: AI_LABEL_KIND[label.label],
        kindBasis: 'ai' as const,
        ai: {
          provider: res.provider,
          model: res.model,
          promptVersion: res.promptVersion,
          runId,
          ...(label.reason ? { reason: label.reason } : {}),
        },
      };
    });
    const before = file.run.ai;
    const hasCost = before?.costUsd !== undefined || res.costUsd !== undefined;
    const ai = {
      id: runId,
      at: new Date().toISOString(),
      provider: res.provider,
      model: res.model,
      promptVersion: res.promptVersion,
      images: (before?.images ?? 0) + res.labels.length,
      detections: (before?.detections ?? 0) + applied,
      inputTokens: (before?.inputTokens ?? 0) + res.inputTokens,
      outputTokens: (before?.outputTokens ?? 0) + res.outputTokens,
      ...(hasCost ? { costUsd: (before?.costUsd ?? 0) + (res.costUsd ?? 0) } : {}),
    };
    return { ...file, run: { ...file.run, ai }, units };
  });
}

// ---------------------------------------------------------------- AI preference

const prefKey = (projectId: string) => `quadrion.telecom.aiLabel.${projectId}`;

export function getAiLabelPref(projectId: string): boolean {
  try {
    return localStorage.getItem(prefKey(projectId)) === '1';
  } catch {
    return false;
  }
}

export function setAiLabelPref(projectId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(prefKey(projectId), '1');
    else localStorage.removeItem(prefKey(projectId));
  } catch {
    /* storage unavailable: the choice lasts only for this session */
  }
}
