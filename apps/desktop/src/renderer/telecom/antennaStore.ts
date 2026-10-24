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
  type Vec3,
} from '@aio/schema';
import type { PointSelection } from '@aio/engine';
import { t } from '@aio/ui';
import { createStore, useStore } from 'zustand';
import { bridge, jobs } from '../shell';
import { isIssueEditing } from '../issueCard/state';
import { revealInList } from '../workspace/workbench/project/projectListStore';
import { toolInFront } from '../workspace/workbench/tabsModel';
import { workbench, type WorkbenchState } from '../workspace/workbench/workbenchStore';
import type { StoreApi } from 'zustand/vanilla';
import type { AntennaMenuAt } from './AntennaMenu';
import { flagParams, newFlagId } from './antennaFlag';
import { boxWithValues, canReset, withTyped, withoutTyped, type TypedKey } from './antennaTyped';
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
  /** The flag tool: null when off; `unit` is the unit being redrawn, null for a new one. */
  flagging: { unit: string | null } | null;
  /** The `telecom.flag` job going, and the unit it adds or redraws. */
  flagJob: { id: string; unit: string } | null;
  /** A `telecom.flag` start waiting for its job id: detection and a second flag are refused. */
  flagStarting: boolean;
  /** The rows ticked for a bulk action in the project list. */
  ticked: Record<string, true>;
  /** A request to fly the camera to these units (the 3D view answers it); `seq` tells repeats. */
  flyRequest: { ids: string[]; seq: number } | null;
  /** A request to focus a typed field of a unit's row (the menu's Edit azimuth); `seq` tells repeats. */
  focusField: { id: string; key: 'azimuthGridDeg' | 'downtiltDeg'; seq: number } | null;
  /** The right-click menu open on a unit (its row or its box in 3D); the runner shows it. */
  menu: AntennaMenuAt | null;
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
  flagging: null,
  flagJob: null,
  flagStarting: false,
  ticked: {},
  flyRequest: null,
  focusField: null,
  menu: null,
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
/** A finished flag job's follow-up (select, box, AI offer), made once the read after it is in. */
let flagAfterLoad: { projectId: string; unit: string; redraw: boolean } | null = null;
/** Whether the flag job going redraws a unit that exists (one flag job at a time). */
let flagRedraw = false;
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
  // a read error's message goes on the next good read, even when no file was there to keep
  const wasError = get().status === 'error';
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
    // a message on screen (a refused write, a failed run) stays; a read error's goes
    message: same && !wasError && get().status !== 'error' ? get().message : null,
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
  if (flagAfterLoad?.projectId === projectId) {
    const after = flagAfterLoad;
    flagAfterLoad = null;
    void afterFlag(after.projectId, after.unit, after.redraw);
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
  onFlagJob(list);
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

/** The `telecom.flag` job, watched beside detection: neither ends the other. */
function onFlagJob(list: readonly JobRecord[]): void {
  const { flagJob } = get();
  if (!flagJob) return;
  const job = list.find((j) => j.id === flagJob.id);
  if (!job) return;
  switch (job.status) {
    case 'done': {
      const { projectId, root } = get();
      set({ flagJob: null });
      if (projectId && root) {
        flagAfterLoad = { projectId, unit: flagJob.unit, redraw: flagRedraw };
        void loadAntennas(projectId, root);
      }
      return;
    }
    case 'failed':
      set({ flagJob: null, message: job.error ?? null });
      return;
    case 'cancelled':
    case 'interrupted':
      set({ flagJob: null });
      return;
    default:
      return;
  }
}

const newRunId = (): string =>
  `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Start `telecom.antennas`; a second call while a run is going is ignored, and so is a call while
 * a flag job starts or runs (its unit is measured in the frame of the run it started on).
 */
export async function runDetection(opts?: { towerHint?: [number, number] }): Promise<void> {
  const s = get();
  if (s.running || s.readOnly || !s.root || flagBusy()) return;
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

// ---------------------------------------------------------------- flagging

/** Whether a flag job is going or starting. */
function flagBusy(): boolean {
  return get().flagStarting || get().flagJob !== null;
}

/**
 * Turn the flag tool on: for a new unit, or with `unitId` to redraw that unit's outline. Refused
 * while detection runs, read-only, with no inventory yet (flagging uses its run) and while a flag
 * job goes.
 */
export function beginFlag(unitId?: string): void {
  const s = get();
  if (s.running || s.readOnly || !s.file || !s.root || flagBusy()) return;
  if (unitId !== undefined && !s.file.units.some((u) => u.id === unitId)) return;
  set({ flagging: { unit: unitId ?? null } });
}

export function endFlag(): void {
  set({ flagging: null });
}

/**
 * The outline is closed: start `telecom.flag` on the kept points of cloud layer `layer` (a new
 * id, or the redrawn unit's) and turn the tool off. The job's end reloads (`onFlagJob`).
 */
export async function startFlag(o: {
  sel: PointSelection;
  bounds: { min: Vec3; max: Vec3 };
  anchor: Vec3;
  layer: string;
}): Promise<void> {
  const s = get();
  const tool = s.flagging;
  set({ flagging: null });
  if (tool && s.running) {
    set({ message: t('telecom.antennas.flag.dropped') });
    return;
  }
  if (!tool || s.readOnly || !s.file || !s.root || flagBusy()) return;
  watchJobs();
  const redraw = tool.unit !== null;
  const unit = tool.unit ?? newFlagId();
  const root = s.root;
  set({ message: null, flagStarting: true });
  const r = await bridge
    .call('jobs:start', {
      pipeline: 'telecom.flag',
      project: root,
      params: flagParams({
        unit,
        redraw,
        layer: o.layer,
        sel: o.sel,
        bounds: o.bounds,
        anchor: o.anchor,
      }),
    })
    .finally(() => {
      set({ flagStarting: false });
    });
  if (get().root !== root) return;
  if (!r.ok || !r.value.ok) {
    set({ message: !r.ok ? r.error : r.value.ok ? '' : r.value.error });
    return;
  }
  flagRedraw = redraw;
  set({ flagJob: { id: r.value.job.id, unit } });
  // the job may already have finished by the time the answer arrives
  const store: Partial<typeof jobs> = jobs;
  if (store.getState) onJobs(store.getState().jobs);
}

/** A typed value of the measured geometry (the ones that move the box). */
const TYPED_KEYS: readonly TypedKey[] = [
  'azimuthGridDeg',
  'downtiltDeg',
  'centreHeightM',
  'widthM',
  'heightM',
  'depthM',
];

/**
 * After a finished flag job's read: select and reveal the unit (the filter goes to all when it
 * would hide it); after a redraw that kept typed
 * values, rebuild its box from them once (the job measured a new box, the typed values win); then
 * offer AI labels for that unit alone when the project has them on.
 */
async function afterFlag(projectId: string, id: string, redraw: boolean): Promise<void> {
  const found = get().file?.units.find((u) => u.id === id);
  if (!found) return;
  // a filter that would hide the new unit shows every unit, so its row is listed
  const { filter } = get();
  if (filter !== 'all' && found.status !== filter) set({ filter: 'all' });
  revealAntenna(id);
  if (redraw && TYPED_KEYS.some((k) => found[k]?.basis === 'user'))
    await change((file) => ({
      ...file,
      units: file.units.map((u) => (u.id === id ? { ...u, box: boxWithValues(u) } : u)),
    }));
  if (get().projectId !== projectId || !getAiLabelPref(projectId)) return;
  const u = get().file?.units.find((x) => x.id === id);
  if (!u || u.kindBasis === 'user' || u.status === 'rejected') return;
  previewAiLabels(projectId, [id]);
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

/** Change one unit; nothing is written when it is not in the file or `edit` returns null. */
function changeUnit(id: string, edit: (u: AntennaUnit) => AntennaUnit | null): Promise<void> {
  return change((file) => {
    const u = file.units.find((x) => x.id === id);
    const next = u ? edit(u) : null;
    if (!next) return null;
    return { ...file, units: file.units.map((x) => (x.id === id ? next : x)) };
  });
}

/** A value the person typed: basis `user`, the measured one kept, the box moved. */
export function setTypedValue(id: string, key: TypedKey, value: number): Promise<void> {
  return changeUnit(id, (u) => withTyped(u, key, value));
}

/** Reset to measured; nothing is written when there is no measured value to go back to. */
export function resetTypedValue(id: string, key: TypedKey): Promise<void> {
  return changeUnit(id, (u) => (canReset(u, key) ? withoutTyped(u, key) : null));
}

/** The kind the person picks: basis `user`, any AI label dropped. */
export function setUnitKind(id: string, kind: AntennaKind): Promise<void> {
  return changeUnit(id, (u) => {
    const next: AntennaUnit = { ...u, kind, kindBasis: 'user' };
    delete next.ai;
    return next;
  });
}

/**
 * Delete units, detected or flagged, through one `telecom:deleteAntennas` call (main writes the
 * deletion record, the file and drops the crops). Queued behind pending writes. On success the
 * file is the one main answers with, and the ids leave the selection, hiding and ticks; a refusal
 * keeps everything as it was and answers why.
 */
export function deleteUnits(
  ids: readonly string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  let result: { ok: true } | { ok: false; error: string } = { ok: false, error: '' };
  const next = queue.then(async () => {
    const { file, projectId, root, readOnly } = get();
    if (!file || !projectId || !root || readOnly || ids.length === 0) return;
    const r = await bridge.call('telecom:deleteAntennas', { projectId, ids: [...ids] });
    if (get().projectId !== projectId) return;
    if (r.ok && r.value.ok) {
      // a read that started before this write would bring back the file it replaced
      loadSeq++;
      const gone = new Set(ids);
      const drop = <V>(m: Record<string, V>): Record<string, V> =>
        Object.fromEntries(Object.entries(m).filter(([k]) => !gone.has(k)));
      const { selected, hidden, ticked } = get();
      set({
        file: r.value.file,
        message: null,
        selected: selected !== null && gone.has(selected) ? null : selected,
        hidden: drop(hidden),
        ticked: drop(ticked),
      });
      result = { ok: true };
      return;
    }
    result = { ok: false, error: !r.ok ? r.error : r.value.ok ? '' : r.value.error };
  });
  queue = next.catch(() => undefined);
  return next.then(() => result);
}

/** Tick or untick a row for a bulk action. */
export function toggleTicked(id: string): void {
  const { ticked } = get();
  if (ticked[id])
    set({ ticked: Object.fromEntries(Object.entries(ticked).filter(([k]) => k !== id)) });
  else set({ ticked: { ...ticked, [id]: true } });
}

export function clearTicked(): void {
  set({ ticked: {} });
}

/** Ask the 3D view to fly to these units. */
export function requestFly(ids: readonly string[]): void {
  set({ flyRequest: { ids: [...ids], seq: (get().flyRequest?.seq ?? 0) + 1 } });
}

/** Ask the unit's row to focus one of its typed fields; selects the unit. */
export function requestFocusField(id: string, key: 'azimuthGridDeg' | 'downtiltDeg'): void {
  set({
    selected: id,
    note: null,
    focusField: { id, key, seq: (get().focusField?.seq ?? 0) + 1 },
  });
}

/** Open the antenna menu on a unit (a right-click on its row or its box in the 3D view). */
export function openAntennaMenu(at: { x: number; y: number; id: string }): void {
  const projectId = get().projectId;
  if (projectId) set({ menu: { ...at, projectId } });
}

export function closeAntennaMenu(): void {
  if (get().menu) set({ menu: null });
}

export function selectAntenna(id: string | null): void {
  set({ selected: id, note: null });
}

/**
 * How the Project tab is brought forward for an explicit ask (a review link, an edit from the
 * menu): the stage registers `showBench`, which also opens a folded sidebar's drawer and gives the
 * bench back from a maximised agent. Injected so the store keeps `../shell` out of its imports.
 */
type ShowProject = (bench: StoreApi<WorkbenchState>) => void;
let showProject: ShowProject = (bench) => {
  bench.getState().show('measure');
};
export function setShowProject(fn: ShowProject): void {
  showProject = fn;
}

/**
 * A unit shown in the Project list: selected, its row revealed (a filter that would hide it shows
 * every unit), the Project tab brought forward. What `ask` says decides how:
 * - none, a pick in the 3D view: the tab comes forward unless a tool is in front (a pick never
 *   takes Coverage or a live tool away; the list updates behind it) and a folded sidebar stays
 *   folded, since the 3D labels still show the pick (`show` alone never pops the drawer);
 * - `review`, a review link: the same, but the person asked for the list, so a folded drawer opens;
 * - `edit`, an edit from the menu: always forward, also over Coverage, drawer opened, as the person
 *   asked to type in the row.
 */
export function revealAntenna(
  id: string | null,
  bench: StoreApi<WorkbenchState> = workbench,
  ask?: 'review' | 'edit',
): void {
  if (id !== null && !filteredUnits(get().file, get().filter).some((u) => u.id === id))
    setAntennaFilter('all');
  set({ selected: id, reveal: get().reveal + 1 });
  revealInList('antennas', id);
  const { tabs, front } = bench.getState();
  if (ask === 'edit') showProject(bench);
  else if (!toolInFront({ tabs, front, issueEditing: isIssueEditing() })) {
    if (ask === 'review') showProject(bench);
    else bench.getState().show('measure');
  }
}

/** Edit azimuth / Edit downtilt: show the row and focus the field (the one path for both menus). */
export function showAntennaField(
  id: string,
  key: 'azimuthGridDeg' | 'downtiltDeg',
  bench: StoreApi<WorkbenchState> = workbench,
): void {
  revealAntenna(id, bench, 'edit');
  requestFocusField(id, key);
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
export function openAntennaReview(bench: StoreApi<WorkbenchState> = workbench): void {
  const first = filteredUnits(get().file, 'draft')[0];
  set({ filter: 'draft', note: null });
  revealAntenna(first?.id ?? null, bench, 'review');
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
  previewAiLabels(projectId, unitIds);
}

/** Ask for the send preview of `unitIds`; the person's yes sends them (`sendAiLabels`). */
function previewAiLabels(projectId: string, unitIds: string[]): void {
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
