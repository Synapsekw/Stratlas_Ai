/**
 * RF coverage in the renderer: the project's antenna inventory (`telecom/antennas.json`, read
 * only), the RF working copy of `rf/sectors.json`, the catalogue, the runs, and everything the
 * tab (T9), the coverage layer (T10) and the entry action (T11) read from them.
 *
 * - Height above ground: the person's value, else box centre minus `run.groundZ` (measured), else
 *   the DSM or terrain at the base (estimated, through `setTerrainProvider`), else unknown.
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
  type PipelinePackStatus,
  type RfAntennaSettings,
  type RfCatalogueEntry,
  type RfRun,
  type RfSector,
  type RfSectorsFile,
  type RfStudy,
} from '@aio/schema';
import { createStore, useStore } from 'zustand';
import { bridge } from '../shell';
import {
  checkRun,
  deriveRows,
  orphansFor,
  proposalFor,
  type RfUnitRow,
  type RunCheck,
  type TerrainAt,
} from './rfModel';

export type {
  ExclusionCode,
  HeightBasis,
  RefusalCode,
  RfUnitRow,
  RunCheck,
  TerrainAt,
  UnitHeight,
} from './rfModel';

export interface PreviewState {
  status: 'idle' | 'computing' | 'ready' | 'error';
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
  // ---- derived (recomputed after every change)
  rows: RfUnitRow[];
  proposed: ProposedSector[];
  /** Eligible units that are in no sector. */
  unassigned: string[];
  orphans: Orphan[];
  check: RunCheck;
}

let terrainAt: TerrainAt | null = null;
/** Guards a slow read against a newer load or a project switch. */
let loadSeq = 0;
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
});

/** The inputs of `check` and the rows, worked out again from the base state. */
function derived(b: Base): Pick<RfState, 'rows' | 'proposed' | 'unassigned' | 'orphans' | 'check'> {
  const rows = deriveRows({
    antennas: b.antennas,
    sectors: b.sectors,
    catalogue: b.catalogue.map((c) => c.entry),
    includeUnreviewed: b.includeUnreviewed,
    terrainAt,
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

/** Resets the store (project closed, or a test). */
export function resetRf(): void {
  loadSeq++;
  terrainAt = null;
  queue = Promise.resolve();
  rfStore.setState(initial());
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
  if (same) set({ status: get().antennas || get().hasFile ? get().status : 'loading' });
  else rfStore.setState({ ...initial(), projectId, status: 'loading' });
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
  const keep = opts.keepEdits === true && get().dirty;
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
  set({ selectedRunId: runId });
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

/** Where the ground is when the antenna file has no tower-base ground (DSM or terrain); null clears it. */
export function setTerrainProvider(fn: TerrainAt | null): void {
  terrainAt = fn;
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
    const antennas = has
      ? f.antennas.map((a) => (a.antennaId === antennaId ? { ...a, ...patch } : a))
      : [...f.antennas, { ...settingsDefaults(antennaId), ...patch }];
    return { ...f, antennas };
  });
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

/** Replace the sectors with the automatic proposal; RF settings are kept. */
export function applyProposal(): void {
  const proposal = get().proposed;
  edit((f) => ({
    ...f,
    sectors: proposal.map<RfSector>((p) => ({ id: p.id, name: p.name, antennaIds: p.antennaIds })),
  }));
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

export function deleteSector(sectorId: string): void {
  edit((f) => ({ ...f, sectors: f.sectors.filter((s) => s.id !== sectorId) }));
}

/** The person's Remove on an orphan: its settings and place go. */
export function removeOrphanEntry(antennaId: string): void {
  edit((f) => removeOrphan(f, antennaId));
}

/** The person's Reassign: an orphan's settings and place move to another unit. Answers a failure message. */
export function reassignOrphanEntry(fromId: string, toId: string): string | null {
  try {
    edit((f) => reassignOrphan(f, fromId, toId));
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    set({ message });
    return message;
  }
}

// ---------------------------------------------------------------- saving

/**
 * Write the working copy. Answers null on success or the failure message. The warnings main
 * returns (pattern files it could not copy) are kept in `writeWarnings`. Saves run one after the
 * other, and a failed one leaves the edits as they are.
 */
export function saveRf(): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    const { projectId, sectors, readOnly } = get();
    if (!projectId) return 'No project is open.';
    if (readOnly) return 'This project is read only.';
    set({ saving: true });
    const r = await bridge.call('rf:writeSectors', { projectId, file: sectors });
    if (get().projectId !== projectId) return null;
    if (!r.ok || !r.value.ok) {
      const error = !r.ok ? r.error : r.value.ok ? '' : r.value.error;
      set({ saving: false, message: error });
      return error || 'The file could not be saved.';
    }
    // An edit made while the write was in flight stays dirty.
    const unchanged = get().sectors === sectors;
    set({
      saving: false,
      message: null,
      hasFile: true,
      dirty: !unchanged,
      writeWarnings: r.value.warnings ?? [],
    });
    return null;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => null);
  return next;
}
