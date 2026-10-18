/**
 * RF coverage in the renderer: the project's antenna inventory (`telecom/antennas.json`, read
 * only), the RF working copy of `rf/sectors.json`, the catalogue, the runs, and everything the
 * tab (T9), the coverage layer (T10) and the entry action (T11) read from them.
 *
 * - Height above ground: the person's value, else box centre minus `run.groundZ` (measured), else
 *   the job's DSM ground near the base (estimated, through `setDsmGroundProvider`), else unknown.
 * - Sectors: `proposed` is the automatic grouping by bearing; `applyProposal()` takes it. A
 *   person can regroup afterwards; grouping never changes the physics.
 * - Orphans (RF entries for units detection no longer has) stay in the file until the person
 *   removes or reassigns them.
 * - `check` says whether a run can start and, if not, why, as codes (`RefusalCode`).
 * - Edits change a working copy (`dirty`); `save()` writes it and keeps the warnings main answers.
 *
 * Nothing here writes `antennas.json`. Bridge calls follow `telecom/antennaStore.ts`.
 */
import { reassignOrphan, removeOrphan, type Orphan, type ProposedSector } from '@aio/rf';
import {
  DEFAULT_RF_STUDY,
  RF_SECTORS_SCHEMA,
  type AntennasFile,
  type CatalogueOrigin,
  type JobRecord,
  type PipelinePackStatus,
  type RfAntennaSettings,
  type RfCarrier,
  type RfCatalogueEntry,
  type RfOrigin,
  type RfRun,
  type RfSector,
  type RfSectorsFile,
  type RfStudy,
} from '@aio/schema';
import { createStore, useStore } from 'zustand';
import { bridge, jobs } from '../shell';
import { applyToFile, type Proposal } from './autoplan/proposal';
import { applyCellRows, type CellRow } from './cellCsv';
import { withEquipment } from './rfFields';
import {
  checkRun,
  deriveRows,
  orphansFor,
  proposalFor,
  type RfUnitRow,
  type RunCheck,
  type DsmGroundAt,
} from './rfModel';

export type {
  ExclusionCode,
  HeightBasis,
  RefusalCode,
  RfUnitRow,
  RunCheck,
  DsmGroundAt,
  UnitHeight,
} from './rfModel';

/** The coverage view the Results section shows and the layer draws (D18). */
export type RfView = 'rsrp' | 'bestServer' | 'overlap';

/** Area of one RSRP class in the selected run, worked out where the grid is read (T10). */
export interface RfClassStat {
  /** Class key: excellent, good, fair, poor or none. */
  cls: 'excellent' | 'good' | 'fair' | 'poor' | 'none';
  areaM2: number;
  /** Share of the study area, 0 to 1. */
  share: number;
}

export interface PreviewState {
  /** `too-large`: the study is past the preview's pixel cap; it can still be run. */
  status: 'idle' | 'computing' | 'ready' | 'error' | 'too-large';
  /** Milliseconds the last preview took. */
  elapsedMs: number | null;
  error: string | null;
}

export interface RfState {
  projectId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  message: string | null;
  readOnly: boolean;
  /** The antenna inventory as detection saved it; null when the project has none. */
  antennas: AntennasFile | null;
  /** The working copy of `rf/sectors.json` (an empty file when the project has none). */
  sectors: RfSectorsFile;
  /** True when the project has an `rf/sectors.json` on disk. */
  hasFile: boolean;
  /** Edited since the last load or save. */
  dirty: boolean;
  /**
   * The plan was saved after the last coverage run of it started, so that run no longer shows it:
   * set by every save, cleared when a run started after the last save is done. The Coverage chip
   * then offers Run instead of the old result. False for a project just opened.
   */
  planChangedSinceRun: boolean;
  saving: boolean;
  /** Warnings from the last `rf:writeSectors` (pattern files that could not be copied). */
  writeWarnings: string[];
  /** Include draft (unreviewed) units in the run; a run that does is marked unreviewed. */
  includeUnreviewed: boolean;
  catalogue: { origin: CatalogueOrigin; entry: RfCatalogueEntry }[];
  catalogueWarnings: string[];
  runs: RfRun[];
  selectedRunId: string | null;
  /** A coverage job this tab started and is still running. */
  running: boolean;
  jobId: string | null;
  /** The installed pipeline pack, as the renderer's processing tools store knows it. */
  pack: Pick<PipelinePackStatus, 'state' | 'version'> | null;
  preview: PreviewState;
  /** Why the last coverage job failed or did not start (main's or the job's text); null when fine. */
  runError: string | null;
  /** The run the last job this tab started writes, until it ends. */
  pendingRunId: string | null;
  /** The view the Results section chose; the coverage layer (T10) draws it. */
  view: RfView;
  /** Per-class areas of the selected run, set by whoever reads its grid (T10); null when unknown. */
  classStats: RfClassStat[] | null;
  /** The unit the tab shows in its Sector section (an Edit RF action sets it); null: the first. */
  focusUnitId: string | null;
  // ---- derived (recomputed after every change)
  rows: RfUnitRow[];
  proposed: ProposedSector[];
  /** Eligible units that are in no sector. */
  unassigned: string[];
  orphans: Orphan[];
  check: RunCheck;
}

let dsmGroundAt: DsmGroundAt | null = null;
/** Guards a slow read against a newer load or a project switch. */
let loadSeq = 0;
/**
 * Saves asked for and not yet ended, and saves ended: a reload that overlaps a save may read the
 * file from before the write, so it keeps the working copy (review M2).
 */
let savesPending = 0;
let savesEnded = 0;
/** Writes run one after the other. */
let queue: Promise<unknown> = Promise.resolve();

const emptyFile = (): RfSectorsFile => ({
  schema: RF_SECTORS_SCHEMA,
  sectors: [],
  antennas: [],
  study: structuredClone(DEFAULT_RF_STUDY),
});

const idlePreview = (): PreviewState => ({ status: 'idle', elapsedMs: null, error: null });

type Base = Omit<RfState, 'rows' | 'proposed' | 'unassigned' | 'orphans' | 'check'>;

const base = (): Base => ({
  projectId: null,
  status: 'idle',
  message: null,
  readOnly: false,
  antennas: null,
  sectors: emptyFile(),
  hasFile: false,
  dirty: false,
  planChangedSinceRun: false,
  saving: false,
  writeWarnings: [],
  includeUnreviewed: false,
  catalogue: [],
  catalogueWarnings: [],
  runs: [],
  selectedRunId: null,
  running: false,
  jobId: null,
  pack: null,
  preview: idlePreview(),
  runError: null,
  pendingRunId: null,
  view: 'rsrp',
  classStats: null,
  focusUnitId: null,
});

/** The inputs of `check` and the rows, worked out again from the base state. */
function derived(b: Base): Pick<RfState, 'rows' | 'proposed' | 'unassigned' | 'orphans' | 'check'> {
  const rows = deriveRows({
    antennas: b.antennas,
    sectors: b.sectors,
    catalogue: b.catalogue.map((c) => c.entry),
    includeUnreviewed: b.includeUnreviewed,
    dsmGroundAt,
  });
  const unassigned = rows
    .filter((r) => r.sectorId === null && r.excluded === 'not-in-sector')
    .map((r) => r.id);
  return {
    rows,
    proposed: proposalFor(b.antennas, b.includeUnreviewed),
    unassigned,
    orphans: orphansFor(b.antennas, b.sectors),
    check: checkRun(rows, {
      sectorMembers: b.sectors.sectors.flatMap((x) => x.antennaIds),
      hasAntennas: b.antennas !== null,
      readOnly: b.readOnly,
      running: b.running,
      pack: b.pack,
    }),
  };
}

const initial = (): RfState => {
  const b = base();
  return { ...b, ...derived(b) };
};

export const rfStore = createStore<RfState>()(initial);

export function useRf<T>(selector: (s: RfState) => T): T {
  return useStore(rfStore, selector);
}

const get = () => rfStore.getState();
/** Apply a patch and work the derived fields out again. */
const set = (patch: Partial<Base>): void => {
  const next = { ...get(), ...patch };
  rfStore.setState({ ...patch, ...derived(next) });
};

/**
 * Resets the store (project closed, or a test). `keepPack` keeps the installed pack, which belongs
 * to the app rather than the project (the RF tab hands it over only when it changes).
 */
export function resetRf(opts: { keepPack?: boolean } = {}): void {
  loadSeq++;
  dsmGroundAt = null;
  queue = Promise.resolve();
  const pack = opts.keepPack === true ? get().pack : null;
  const b = { ...base(), pack };
  rfStore.setState({ ...b, ...derived(b) });
}

// ---------------------------------------------------------------- loading

/**
 * Read the antenna inventory, `rf/sectors.json`, the catalogue and the runs. Safe to call again
 * for the same project (a reload keeps a pending edit only if `keepEdits`) and when the project
 * changes (everything is dropped).
 */
export async function loadRf(projectId: string, opts: { keepEdits?: boolean } = {}): Promise<void> {
  const seq = ++loadSeq;
  const same = get().projectId === projectId;
  const pendingAtStart = savesPending;
  const endedAtStart = savesEnded;
  if (same) set({ status: get().antennas || get().hasFile ? get().status : 'loading' });
  else {
    // The installed pack belongs to the app, not the project; the ground provider to the project.
    dsmGroundAt = null;
    rfStore.setState({ ...initial(), pack: get().pack, projectId, status: 'loading' });
    set({});
  }
  const [ant, sec, cat, runs] = await Promise.all([
    bridge.call('telecom:readAntennas', { projectId }),
    bridge.call('rf:readSectors', { projectId }),
    bridge.call('rf:listCatalogue', { projectId }),
    bridge.call('rf:listRuns', { projectId }),
  ]);
  if (seq !== loadSeq || get().projectId !== projectId) return;
  const bad = !ant.ok
    ? ant.error
    : !ant.value.ok
      ? ant.value.error
      : !sec.ok
        ? sec.error
        : !sec.value.ok
          ? sec.value.error
          : null;
  if (bad !== null || !ant.ok || !ant.value.ok || !sec.ok || !sec.value.ok) {
    set({ status: 'error', message: bad ?? '' });
    return;
  }
  // a save in flight, or ended, while this read ran: the file read may be the one from before it
  const overlapped =
    same && (pendingAtStart > 0 || savesPending > 0 || savesEnded !== endedAtStart);
  const keep = (opts.keepEdits === true && get().dirty) || overlapped;
  set({
    status: 'ready',
    message: null,
    antennas: ant.value.file,
    readOnly: sec.value.readOnly,
    hasFile: sec.value.file !== null,
    ...(keep ? {} : { sectors: sec.value.file ?? emptyFile(), dirty: false }),
    catalogue: cat.ok && cat.value.ok ? cat.value.entries : [],
    catalogueWarnings: cat.ok && cat.value.ok ? cat.value.warnings : [],
    runs: runs.ok && runs.value.ok ? runs.value.runs : [],
  });
  const sel = get().selectedRunId;
  if (sel && !get().runs.some((r) => r.runId === sel)) set({ selectedRunId: null });
}

/** The runs on disk, newest first (after a job finished). */
export async function refreshRuns(): Promise<void> {
  const projectId = get().projectId;
  if (!projectId) return;
  const r = await bridge.call('rf:listRuns', { projectId });
  if (get().projectId !== projectId) return;
  if (r.ok && r.value.ok) set({ runs: r.value.runs });
}

/** Select a run and read its `run.json` again (it may have been written since the listing). */
export async function selectRun(runId: string | null): Promise<void> {
  set({ selectedRunId: runId, classStats: null });
  const projectId = get().projectId;
  if (!projectId || runId === null) return;
  const r = await bridge.call('rf:readRun', { projectId, runId: runId });
  if (get().projectId !== projectId || !r.ok || !r.value.ok) return;
  const run = r.value.run;
  const runs = get().runs;
  set({
    runs: runs.some((x) => x.runId === runId)
      ? runs.map((x) => (x.runId === runId ? run : x))
      : [run, ...runs],
  });
}

// ---------------------------------------------------------------- environment

/** The installed pipeline pack (`useProcessingTools((s) => s.status)`); drives the pack refusals. */
export function setPackStatus(status: Pick<PipelinePackStatus, 'state' | 'version'> | null): void {
  set({
    pack: status
      ? {
          state: status.state,
          ...(status.version === undefined ? {} : { version: status.version }),
        }
      : null,
  });
}

/**
 * The DSM ground near a tower base, used when the antenna file has no tower-base ground. It must
 * do what the job does (see `DsmGroundAt`). Cleared when the project changes, so set it after
 * `loadRf`; null clears it.
 */
export function setDsmGroundProvider(fn: DsmGroundAt | null): void {
  dsmGroundAt = fn;
  set({});
}

export function setRunning(running: boolean, jobId: string | null = null): void {
  set({ running, jobId: running ? jobId : null });
}

export function setPreviewState(patch: Partial<PreviewState>): void {
  set({ preview: { ...get().preview, ...patch } });
}

export function setIncludeUnreviewed(on: boolean): void {
  set({ includeUnreviewed: on });
}

// ---------------------------------------------------------------- edits

function edit(fn: (f: RfSectorsFile) => RfSectorsFile): void {
  if (get().readOnly) return;
  set({ sectors: fn(get().sectors), dirty: true });
}

/**
 * Apply the reviewed CSV rows (`cellCsv.ts`) to the working copy; nothing is written until
 * `saveRf()`. Read-only projects ignore it.
 */
export function applyCellImport(rows: readonly CellRow[]): void {
  const catalogue = get().catalogue.map((c) => c.entry);
  edit((f) => applyCellRows(f, rows, catalogue));
}

/**
 * Write a reviewed Auto-plan proposal into the working copy (nothing is saved here); each group it
 * writes carries its origin. Read-only projects ignore it.
 */
export function applyPlan(p: Proposal): void {
  const catalogue = get().catalogue.map((c) => c.entry);
  edit((f) => applyToFile(f, p, catalogue));
}

const USER: RfOrigin = { by: 'user' };

/** A group the person set by hand. */
const markOrigins = (
  a: RfAntennaSettings,
  keys: ('equipment' | 'etiltDeg')[],
): RfAntennaSettings =>
  keys.length === 0
    ? a
    : { ...a, origins: { ...a.origins, ...Object.fromEntries(keys.map((k) => [k, USER])) } };

const withoutOrigin = (c: RfCarrier): RfCarrier => {
  const rest = { ...c };
  delete rest.origin;
  return rest;
};

/** Carriers the patch changed (or added), by id, marked as the person's. */
function markCarriers(old: readonly RfCarrier[], next: readonly RfCarrier[]): RfCarrier[] {
  return next.map((c) => {
    const was = old.find((o) => o.id === c.id);
    if (was && JSON.stringify(withoutOrigin(was)) === JSON.stringify(withoutOrigin(c))) {
      return was.origin ? { ...c, origin: was.origin } : c;
    }
    return { ...c, origin: USER };
  });
}

const settingsDefaults = (antennaId: string): RfAntennaSettings => ({
  antennaId,
  active: true,
  carriers: [],
});

/** Create or change one unit's RF settings. */
export function patchSettings(
  antennaId: string,
  patch: Partial<Omit<RfAntennaSettings, 'antennaId'>>,
): void {
  edit((f) => {
    const has = f.antennas.some((a) => a.antennaId === antennaId);
    const marked = (base: RfAntennaSettings): RfAntennaSettings => {
      const merged = { ...base, ...patch };
      const withCarriers = patch.carriers
        ? { ...merged, carriers: markCarriers(base.carriers, patch.carriers) }
        : merged;
      return 'etiltDeg' in patch ? markOrigins(withCarriers, ['etiltDeg']) : withCarriers;
    };
    const antennas = has
      ? f.antennas.map((a) => (a.antennaId === antennaId ? marked(a) : a))
      : [...f.antennas, marked(settingsDefaults(antennaId))];
    return { ...f, antennas };
  });
}

/**
 * Change a unit's equipment by the one rule (`withEquipment`): an AAU strips radios and ports, a
 * new antenna drops ports it lacks, the e-tilt is clamped into the new range. Answers false when
 * a radio is chosen without a separate antenna (nothing changes).
 */
export function setEquipment(antennaId: string, entry: RfCatalogueEntry): boolean {
  if (get().readOnly) return false;
  const catalogue = get().catalogue.map((c) => c.entry);
  const current =
    get().sectors.antennas.find((a) => a.antennaId === antennaId) ?? settingsDefaults(antennaId);
  const next = withEquipment(current, entry, catalogue);
  if (!next) return false;
  const marked = markOrigins(next, ['equipment']);
  edit((f) => ({
    ...f,
    antennas: f.antennas.some((a) => a.antennaId === antennaId)
      ? f.antennas.map((a) => (a.antennaId === antennaId ? marked : a))
      : [...f.antennas, marked],
  }));
  return true;
}

/** Clear one optional setting of a unit (back to the job's default): the equipment or the e-tilt. */
export function clearSetting(antennaId: string, key: 'equipment' | 'etiltDeg'): void {
  edit((f) => ({
    ...f,
    antennas: f.antennas.map((a) => {
      if (a.antennaId !== antennaId) return a;
      const rest = { ...a };
      if (key === 'equipment') delete rest.equipment;
      else delete rest.etiltDeg;
      return markOrigins(rest, [key]);
    }),
  }));
}

/** The person's height above ground; undefined clears it (back to measured or estimated). */
export function setHeightOverride(antennaId: string, heightM: number | undefined): void {
  edit((f) => {
    const antennas = f.antennas.map((a) => {
      if (a.antennaId !== antennaId) return a;
      const rest = { ...a };
      delete rest.heightOverrideM;
      return heightM === undefined ? rest : { ...rest, heightOverrideM: heightM };
    });
    if (f.antennas.some((a) => a.antennaId === antennaId)) return { ...f, antennas };
    if (heightM === undefined) return f;
    return {
      ...f,
      antennas: [...f.antennas, { ...settingsDefaults(antennaId), heightOverrideM: heightM }],
    };
  });
}

export function patchStudy(patch: Partial<RfStudy>): void {
  edit((f) => ({ ...f, study: { ...f.study, ...patch } }));
}

/** Sector places of RF entries for units detection no longer has (D9: never dropped silently). */
function orphanPlaces(f: RfSectorsFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const o of get().orphans) {
    if (o.sectorId === null || !f.sectors.some((x) => x.id === o.sectorId)) continue;
    out.set(o.sectorId, [...(out.get(o.sectorId) ?? []), o.antennaId]);
  }
  return out;
}

/**
 * Replace the sectors with the automatic proposal; RF settings are kept, and so is every orphan's
 * place: in the proposed sector with the same id, else in its old sector, which stays with only
 * the orphans in it.
 */
export function applyProposal(): void {
  const proposal = get().proposed;
  edit((f) => {
    const places = orphanPlaces(f);
    const next = proposal.map<RfSector>((p) => ({
      id: p.id,
      name: p.name,
      antennaIds: [...p.antennaIds, ...(places.get(p.id) ?? [])],
    }));
    const kept = f.sectors.flatMap<RfSector>((old) =>
      places.has(old.id) && !next.some((n) => n.id === old.id)
        ? [{ ...old, antennaIds: places.get(old.id) ?? [] }]
        : [],
    );
    return { ...f, sectors: [...next, ...kept] };
  });
}

export function renameSector(sectorId: string, name: string): void {
  const n = name.trim();
  if (!n) return;
  edit((f) => ({
    ...f,
    sectors: f.sectors.map((s) => (s.id === sectorId ? { ...s, name: n } : s)),
  }));
}

/** Put a unit in a sector (it leaves its old one); null takes it out of every sector. */
export function moveUnit(antennaId: string, sectorId: string | null): void {
  edit((f) => ({
    ...f,
    sectors: f.sectors.map((s) => {
      const rest = s.antennaIds.filter((id) => id !== antennaId);
      return s.id === sectorId
        ? { ...s, antennaIds: [...rest, antennaId] }
        : { ...s, antennaIds: rest };
    }),
  }));
}

/** Add an empty sector named by the next free S<n>. */
export function addSector(): string {
  const f = get().sectors;
  let n = f.sectors.length + 1;
  const ids = new Set(f.sectors.map((s) => s.id));
  while (ids.has(`sec-s${String(n)}`)) n++;
  const id = `sec-s${String(n)}`;
  edit((file) => ({
    ...file,
    sectors: [...file.sectors, { id, name: `S${String(n)}`, antennaIds: [] }],
  }));
  return id;
}

/** Delete a sector. Orphans in it stay (D9): the sector remains with only them until they are removed or reassigned. */
export function deleteSector(sectorId: string): void {
  edit((f) => {
    const orphans = orphanPlaces(f).get(sectorId) ?? [];
    return {
      ...f,
      sectors:
        orphans.length === 0
          ? f.sectors.filter((s) => s.id !== sectorId)
          : f.sectors.map((s) => (s.id === sectorId ? { ...s, antennaIds: orphans } : s)),
    };
  });
}

/** The person's Remove on an orphan: its settings and place go. */
export function removeOrphanEntry(antennaId: string): void {
  edit((f) => removeOrphan(f, antennaId));
}

export type ReassignResult = null | 'read-only' | 'target-has-settings' | 'failed';

/** The person's Reassign: an orphan's settings and place move to another unit. Answers null or why not. */
export function reassignOrphanEntry(fromId: string, toId: string): ReassignResult {
  if (get().readOnly) return 'read-only';
  if (get().sectors.antennas.some((a) => a.antennaId === toId && fromId !== toId))
    return 'target-has-settings';
  try {
    edit((f) => reassignOrphan(f, fromId, toId));
    return null;
  } catch {
    return 'failed';
  }
}

// ---------------------------------------------------------------- saving

export type SaveResult =
  | { ok: true }
  | { ok: false; code: 'no-project' | 'read-only' }
  /** Main refused or failed the write; `message` is main's text. */
  | { ok: false; code: 'refused'; message: string };

/**
 * Write the working copy. The warnings main returns (pattern files it could not copy) are kept in
 * `writeWarnings`. Saves run one after the other, and a failed one leaves the edits as they are.
 */
export function saveRf(): Promise<SaveResult> {
  const run = async (): Promise<SaveResult> => {
    const { projectId, sectors, readOnly } = get();
    if (!projectId) return { ok: false, code: 'no-project' };
    if (readOnly) return { ok: false, code: 'read-only' };
    set({ saving: true });
    const r = await bridge.call('rf:writeSectors', { projectId, file: sectors });
    if (get().projectId !== projectId) return { ok: true };
    if (!r.ok || !r.value.ok) {
      const error = !r.ok ? r.error : r.value.ok ? '' : r.value.error;
      set({ saving: false, message: error });
      return { ok: false, code: 'refused', message: error };
    }
    // An edit made while the write was in flight stays dirty.
    const unchanged = get().sectors === sectors;
    plansSaved++;
    set({
      planChangedSinceRun: true,
      saving: false,
      message: null,
      hasFile: true,
      dirty: !unchanged,
      writeWarnings: r.value.warnings ?? [],
    });
    return { ok: true };
  };
  savesPending++;
  const ended = () => {
    savesPending--;
    savesEnded++;
  };
  const next = queue.then(run, run);
  next.then(ended, ended);
  queue = next.catch(() => null);
  return next;
}

// ---------------------------------------------------------------- view (T9 tab, T10 layer)

export function setView(view: RfView): void {
  set({ view });
}

/** The selected run's per-class areas, from whoever reads its grid (T10); null clears them. */
export function setClassStats(stats: RfClassStat[] | null): void {
  set({ classStats: stats });
}

/** Show this unit in the tab's Sector section (an Edit RF action); null: the first unit. */
export function focusRfUnit(antennaId: string | null): void {
  set({ focusUnitId: antennaId });
}

// ---------------------------------------------------------------- catalogue

/** Read the catalogue again (after an import). */
export async function refreshCatalogue(): Promise<void> {
  const projectId = get().projectId;
  const r = await bridge.call('rf:listCatalogue', projectId ? { projectId } : {});
  if (get().projectId !== projectId || !r.ok || !r.value.ok) return;
  set({ catalogue: r.value.entries, catalogueWarnings: r.value.warnings });
}

export type ImportResult =
  | { ok: true; added: number; warnings: string[] }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string };

/**
 * Import into the person's catalogue through the open dialog: an MSI / Planet pattern attached to
 * one antenna port, or a catalogue file. The dialog's title and filter names are the caller's.
 */
export async function importCatalogue(
  format: 'msi' | 'catalogue',
  dialog: { title: string; filterName: string },
  attach?: { entryId: string; portId: string },
): Promise<ImportResult> {
  const pick = await bridge.call('dialog:openFile', {
    title: dialog.title,
    filters: [
      {
        name: dialog.filterName,
        extensions: format === 'msi' ? ['msi', 'pln', 'txt'] : ['json'],
      },
    ],
  });
  if (!pick.ok) return { ok: false, cancelled: false, message: pick.error };
  const path = pick.value.path;
  if (path === null) return { ok: false, cancelled: true };
  const r = await bridge.call('rf:importCatalogue', {
    path,
    format,
    ...(attach ? { attach } : {}),
  });
  if (!r.ok || !r.value.ok) {
    const message = !r.ok ? r.error : r.value.ok ? '' : r.value.error;
    return { ok: false, cancelled: false, message };
  }
  await refreshCatalogue();
  return { ok: true, added: r.value.entries.length, warnings: r.value.warnings };
}

// ---------------------------------------------------------------- the coverage job

export type ExportFormat = 'geotiff' | 'geojson' | 'csv';

/** Export the selected run through the save dialog; answers the path, null when cancelled, or why not. */
export async function exportRun(
  format: ExportFormat,
): Promise<{ ok: true; path: string | null } | { ok: false; message: string }> {
  const { projectId, selectedRunId, view } = get();
  if (!projectId || !selectedRunId) return { ok: false, message: '' };
  const r = await bridge.call('rf:export', {
    projectId,
    runId: selectedRunId,
    format,
    ...(format === 'csv' ? {} : { view }),
  });
  if (!r.ok || !r.value.ok) {
    return { ok: false, message: !r.ok ? r.error : r.value.ok ? '' : r.value.error };
  }
  return { ok: true, path: r.value.path };
}

let watchingJobs = false;
/** Saves written so far, and how many there were when the run going now started. */
let plansSaved = 0;
let plansSavedAtRun = 0;
function watchJobs(): void {
  // tests of other modules mock the shell with a bridge only
  const store: Partial<typeof jobs> = jobs;
  if (watchingJobs || !store.subscribe) return;
  watchingJobs = true;
  store.subscribe((s) => {
    onJobs(s.jobs);
  });
}

function onJobs(list: readonly JobRecord[]): void {
  const { jobId, running, pendingRunId } = get();
  if (!jobId || !running) return;
  const job = list.find((j) => j.id === jobId);
  if (!job) return;
  if (job.status === 'done') {
    set({
      running: false,
      jobId: null,
      pendingRunId: null,
      runError: null,
      // the run shows the plan unless it was saved again while the run went
      planChangedSinceRun: plansSaved !== plansSavedAtRun,
    });
    void refreshRuns().then(() => {
      if (pendingRunId && get().runs.some((r) => r.runId === pendingRunId))
        void selectRun(pendingRunId);
    });
  } else if (job.status === 'failed') {
    set({ running: false, jobId: null, pendingRunId: null, runError: job.error ?? '' });
  } else if (job.status === 'cancelled' || job.status === 'interrupted') {
    set({ running: false, jobId: null, pendingRunId: null });
  }
}

const newRunId = (): string =>
  `rf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export type StartResult =
  | { ok: true; jobId: string; runId: string }
  /** The run check refused (see `check.refusals`), or a save before the start failed. */
  | { ok: false; code: 'refused' | 'not-saved' }
  /** Main refused the job; `message` is its text (also in `runError`). */
  | { ok: false; code: 'failed'; message: string };

/**
 * Start `rf.coverage` through the job runner (`jobs:start`), as the antenna detection does. A
 * working copy with edits is saved first, because the job reads `rf/sectors.json`. A run covers
 * every eligible sector (sector subsets are deferred). `root` is the project folder.
 */
export async function startCoverage(root: string): Promise<StartResult> {
  if (get().check.refusals.length > 0) return { ok: false, code: 'refused' };
  const projectId = get().projectId;
  if (get().dirty) {
    const saved = await saveRf();
    if (!saved.ok) return { ok: false, code: 'not-saved' };
  }
  if (get().projectId !== projectId || get().check.refusals.length > 0)
    return { ok: false, code: 'refused' };
  watchJobs();
  // the job reads the file as saved now
  plansSavedAtRun = plansSaved;
  const runId = newRunId();
  set({ running: true, pendingRunId: runId, runError: null });
  const r = await bridge.call('jobs:start', {
    pipeline: 'rf.coverage',
    project: root,
    params: { runId, ...(get().includeUnreviewed ? { includeUnreviewed: true } : {}) },
  });
  if (get().projectId !== projectId) return { ok: false, code: 'refused' };
  if (!r.ok || !r.value.ok) {
    const message = !r.ok ? r.error : r.value.ok ? '' : r.value.error;
    set({ running: false, jobId: null, pendingRunId: null, runError: message });
    return { ok: false, code: 'failed', message };
  }
  const jobId = r.value.job.id;
  set({ jobId });
  // the job may already have ended by the time the answer arrives
  const store: Partial<typeof jobs> = jobs;
  if (store.getState) onJobs(store.getState().jobs);
  return { ok: true, jobId, runId };
}
