/**
 * Telecom antenna inventory in the renderer: the project's `telecom/antennas.json`, the
 * `telecom.antennas` job, review (accept / reject), the fields a person types, the selection and
 * the merge of AI labels. Each review change is written at once. AI labels change only `kind`,
 * `kindBasis` and `ai`, never a number.
 */
import {
  AI_LABEL_KIND,
  TOWER_HINT_NEEDED,
  type AntennaKind,
  type AntennasFile,
  type AntennaStatus,
  type AntennaUnit,
  type AntennaUserFields,
  type IpcResponse,
  type JobRecord,
} from '@aio/schema';
import { t } from '@aio/ui';
import { createStore, useStore } from 'zustand';
import { bridge, jobs } from '../shell';
import { isAntennaDrawn, type AntennaFilter, type AntennaLabelMode } from './antennaVisibility';

export { isAntennaDrawn, type AntennaFilter, type AntennaLabelMode };

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
  /** Which review status the inventory and the walk show. */
  filter: AntennaFilter;
  /** Only this kind is drawn in 3D (the selected unit aside); null: every kind. */
  solo: AntennaKind | null;
  /** A transient status line (such as "all done"); cleared by the next selection or filter change. */
  note: string | null;
  /** null = automatic (the newest visible cloud). */
  cloudLayer: string | null;
  /** The AI labelling request waiting for the person's yes (the send preview), if any. */
  aiPreview: AiPreview | null;
  /** Why the last AI labelling did not happen, if it did not. */
  aiNote: string | null;
  /** Counts the units picked in the 3D view: each pick reveals its row (0: none yet). */
  reveal: number;
  /** Which labels the 3D view shows; for the session only, never written to the file. */
  labelMode: AntennaLabelMode;
}

export interface AiPreview {
  value: Extract<IpcResponse<'ai:antennaLabelPreview'>, { ok: true }>;
  projectId: string;
  unitIds: string[];
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
  filter: 'all',
  solo: null,
  note: null,
  cloudLayer: null,
  aiPreview: null,
  aiNote: null,
  reveal: 0,
  labelMode: 'all',
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
/** A finished run's AI offer, made once the inventory read after it is in (whichever read). */
let offerAfterLoad: { projectId: string; before: string | null } | null = null;
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
  const previousRunId = same ? (get().file?.run.id ?? null) : null;
  if (same) set({ status: get().file ? get().status : 'loading' });
  // the reveal count carries on: the inventory section tells a new reveal by it; the labels
  // setting is the person's for the session
  else
    set({
      ...initial(),
      reveal: get().reveal,
      labelMode: get().labelMode,
      projectId,
      root,
      status: 'loading',
    });
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
  // a new project or a new detection run starts on what is left to review
  const newRun = !same || (file !== null && file.run.id !== previousRunId);
  const startFilter: Partial<AntennaState> = newRun
    ? { filter: file?.units.some((u) => u.status === 'draft') ? 'draft' : 'all' }
    : {};
  set({
    ...startFilter,
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
  if (offerAfterLoad?.projectId === projectId) {
    const { before } = offerAfterLoad;
    offerAfterLoad = null;
    offerAiLabels(projectId, before);
  }
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
      const { projectId, root, file } = get();
      set({ running: false, jobId: null, needsHint: false, message: null });
      if (projectId && root) {
        // a newer read (a bench mounting meanwhile) may supersede this one: the offer follows
        // whichever read brings the new file in
        offerAfterLoad = { projectId, before: file?.run.id ?? null };
        void loadAntennas(projectId, root);
      }
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
      // a read that started before this write would bring back the file it replaced
      loadSeq++;
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
  set({ selected: id, note: null });
}

/** A unit picked in the 3D view: selected, and its row revealed in the inventory. */
export function revealAntenna(id: string): void {
  set({ selected: id, reveal: get().reveal + 1 });
}

export function toggleAntennaHidden(id: string): void {
  const { hidden } = get();
  if (hidden[id])
    set({ hidden: Object.fromEntries(Object.entries(hidden).filter(([k]) => k !== id)) });
  else set({ hidden: { ...hidden, [id]: true } });
}

/** The order the panel groups kinds in (and the review walk steps through). */
export const KIND_ORDER: readonly AntennaKind[] = ['panel', 'short', 'dish', 'other'];

/** The units a filter shows, in the panel's order: by kind, then file order within a kind. */
export function filteredUnits(file: AntennasFile | null, filter: AntennaFilter): AntennaUnit[] {
  if (!file) return [];
  const shown = filter === 'all' ? file.units : file.units.filter((u) => u.status === filter);
  return KIND_ORDER.flatMap((k) => shown.filter((u) => u.kind === k));
}

/**
 * Switch the filter. No selection stays none (a filter lists, it opens no card); a selection
 * outside the new filter moves to its first unit, or to none when it is empty.
 */
export function setAntennaFilter(f: AntennaFilter): void {
  const { file, selected } = get();
  const list = filteredUnits(file, f);
  const next =
    selected === null || list.some((u) => u.id === selected) ? selected : (list[0]?.id ?? null);
  set({ filter: f, note: null, selected: next });
}

/**
 * Start reviewing the drafts (another tool's "review antennas"): the "To review" filter, its first
 * unit in the panel's order selected and revealed (the section opens, the row scrolls into view,
 * the camera frames it and the card shows). With no draft, the inventory section only opens.
 */
export function openAntennaReview(): void {
  const first = filteredUnits(get().file, 'draft')[0];
  set({ filter: 'draft', note: null });
  if (first) revealAntenna(first.id);
  else set({ selected: null, reveal: get().reveal + 1 });
}

/** The group eye: hide the whole kind when any of it shows, else show it all. */
export function toggleGroupHidden(kind: AntennaKind): void {
  const { file, hidden } = get();
  const ids = (file?.units ?? []).filter((u) => u.kind === kind).map((u) => u.id);
  if (ids.length === 0) return;
  if (ids.some((id) => !hidden[id])) {
    const next = { ...hidden };
    for (const id of ids) next[id] = true;
    set({ hidden: next });
  } else {
    const gone = new Set(ids);
    set({
      hidden: Object.fromEntries(Object.entries(hidden).filter(([k]) => !gone.has(k))),
    });
  }
}

export function hideAllAntennas(): void {
  const next: Record<string, true> = {};
  for (const u of get().file?.units ?? []) next[u.id] = true;
  set({ hidden: next });
}

/** Show every unit: clears the hidden map and the solo. */
export function showAllAntennas(): void {
  set({ hidden: {}, solo: null });
}

/** Draw only one kind (the selected unit aside); null draws every kind. Never touches `hidden`. */
export function setAntennaSolo(kind: AntennaKind | null): void {
  set({ solo: kind });
}

/** Which labels the 3D view shows (session only). */
export function setLabelMode(mode: AntennaLabelMode): void {
  set({ labelMode: mode });
}

const LABEL_MODES: readonly AntennaLabelMode[] = ['off', 'selected', 'all'];

/** The next labels setting: off, selected, all, then off again. */
export function cycleLabelMode(): void {
  const at = LABEL_MODES.indexOf(get().labelMode);
  set({ labelMode: LABEL_MODES[(at + 1) % LABEL_MODES.length] ?? 'all' });
}

/** Step the selection through the filtered list, wrapping at the ends. */
export function stepAntenna(dir: 1 | -1): void {
  const { file, filter, selected } = get();
  const list = filteredUnits(file, filter);
  if (list.length === 0) return;
  const at = list.findIndex((u) => u.id === selected);
  const next = at < 0 ? (dir === 1 ? 0 : list.length - 1) : (at + dir + list.length) % list.length;
  set({ selected: list[next]?.id ?? null, note: null });
}

/**
 * Accept or reject the selected unit (the same again returns it to draft). When it then leaves the
 * filter, the selection moves to the unit now at its place, or says the filter is done.
 */
export async function decideAntenna(status: 'accepted' | 'rejected'): Promise<void> {
  const { file, filter, selected, readOnly } = get();
  if (readOnly || !selected) return;
  const current = file?.units.find((u) => u.id === selected);
  if (!current) return;
  const index = filteredUnits(file, filter).findIndex((u) => u.id === selected);
  await setUnitStatus(selected, current.status === status ? 'draft' : status);
  const after = get();
  if (after.selected !== selected || filter === 'all' || after.filter !== filter) return;
  const list = filteredUnits(after.file, filter);
  if (list.some((u) => u.id === selected)) return;
  if (list.length === 0) {
    set({ selected: null, note: t('telecom.antennas.filterDone') });
    return;
  }
  set({ selected: list[Math.min(Math.max(index, 0), list.length - 1)]?.id ?? null, note: null });
}

// ---------------------------------------------------------------- AI labels

/**
 * Merge AI labels into the file. Only `kind`, `kindBasis` and `ai` of a unit change; a kind a
 * person set stays. The run's AI usage is recorded on the run. `projectId` is the project the
 * request was sent for: after a switch to another project, or when no unit took a label, nothing
 * is written (and no AI usage is recorded).
 */
export function applyAiLabels(
  res: Extract<IpcResponse<'ai:labelAntennas'>, { ok: true }>,
  runId: string,
  projectId: string,
): Promise<void> {
  return change((file) => {
    if (get().projectId !== projectId) return null;
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
    if (applied === 0) return null;
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

/** Unwrap a bridge answer to its value, or the text of why not. */
function unwrap<T extends { ok: boolean }>(
  r: { ok: true; value: T } | { ok: false; error: string },
): { ok: true; value: Extract<T, { ok: true }> } | { ok: false; error: string } {
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.value.ok) return { ok: false, error: (r.value as { error?: string }).error ?? '' };
  return { ok: true, value: r.value as Extract<T, { ok: true }> };
}

const MAX_AI_UNITS = 200;

/**
 * After a run: when the project has AI labelling on and the file now holds a new run, ask for the
 * send preview of its unlabelled units. Nothing is sent until the person says yes
 * (`sendAiLabels`).
 */
function offerAiLabels(projectId: string, before: string | null): void {
  const { file, status } = get();
  if (get().projectId !== projectId || status !== 'ready' || !file || file.run.id === before)
    return;
  if (!getAiLabelPref(projectId)) return;
  const unitIds = file.units
    .filter((u) => u.kindBasis !== 'user' && u.status !== 'rejected' && !u.notFoundInLatest)
    .map((u) => u.id)
    .slice(0, MAX_AI_UNITS);
  if (unitIds.length === 0) return;
  void bridge.call('ai:antennaLabelPreview', { projectId, unitIds }).then((r) => {
    if (get().projectId !== projectId) return;
    const v = unwrap(r);
    if (v.ok) set({ aiPreview: { value: v.value, projectId, unitIds }, aiNote: null });
    else set({ aiNote: v.error });
  });
}

/** The person's yes to the send preview: label the units, with the photo crops when `photos`. */
export async function sendAiLabels(photos: boolean): Promise<void> {
  const p = get().aiPreview;
  set({ aiPreview: null });
  if (!p) return;
  const runId = `ai-${String(Date.now())}`;
  const r = await bridge.call('ai:labelAntennas', {
    runId,
    projectId: p.projectId,
    unitIds: p.unitIds,
    token: p.value.token,
    ...(photos ? { photos: true } : {}),
  });
  const v = unwrap(r);
  if (v.ok) await applyAiLabels(v.value, runId, p.projectId);
  else if (get().projectId === p.projectId) set({ aiNote: v.error });
}

export function cancelAiLabels(): void {
  set({ aiPreview: null });
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
