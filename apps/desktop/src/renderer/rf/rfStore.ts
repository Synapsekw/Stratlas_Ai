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
 *   `saved` is the plan as it is on disk. A rename and a restored sector place change both copies
 *   and write the saved one only, so unsaved edits are neither written nor lost.
 * - Whether the plan changed since a run is worked out from what is saved: the saved plan against
 *   the plan the run recorded (`selectPlanChanged`), so it is the same after a reopen.
 * - The coverage job: one this tab started, or one already going for the open project (adopted
 *   from the jobs list), holds `running`; a job that leaves the list without an end ends it.
 *
 * Nothing here writes `antennas.json`. Bridge calls follow `telecom/antennaStore.ts`.
 */
import { reassignOrphan, removeOrphan, type Orphan, type ProposedSector } from '@aio/rf';
import {
  DEFAULT_RF_STUDY,
  RF_SECTORS_SCHEMA,
  RfSectorsFile,
  mergeRfOrigins,
  splitRfOrigins,
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
  type RfStudy,
} from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { createStore, useStore } from 'zustand';
import { isActive, sameFolder } from '../jobs';
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
   * The plan as it is in `rf/sectors.json` (read, or last written), origins merged; null when the
   * project has none. `selectPlanChanged` compares it with the plan a run recorded.
   */
  saved: RfSectorsFile | null;
  saving: boolean;
  /** Warnings from the last `rf:writeSectors` (pattern files that could not be copied). */
  writeWarnings: string[];
  /** Include draft (unreviewed) units in the run; a run that does is marked unreviewed. */
  includeUnreviewed: boolean;
  catalogue: { origin: CatalogueOrigin; entry: RfCatalogueEntry }[];
  catalogueWarnings: string[];
  runs: RfRun[];
  selectedRunId: string | null;
  /** A coverage job of the open project is going: one this tab started, or one adopted on load. */
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

type Base = Omit<RfState, 'rows' | 'proposed' | 'orphans' | 'check'>;

const base = (): Base => ({
  projectId: null,
  status: 'idle',
  message: null,
  readOnly: false,
  antennas: null,
  sectors: emptyFile(),
  hasFile: false,
  dirty: false,
  saved: null,
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
function derived(b: Base): Pick<RfState, 'rows' | 'proposed' | 'orphans' | 'check'> {
  const rows = deriveRows({
    antennas: b.antennas,
    sectors: b.sectors,
    catalogue: b.catalogue.map((c) => c.entry),
    includeUnreviewed: b.includeUnreviewed,
    dsmGroundAt,
  });
  return {
    rows,
    proposed: proposalFor(b.antennas, b.includeUnreviewed),
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

// ---------------------------------------------------------------- selectors

/** A plan in one spelling: parsed as main reads it (defaults filled), keys sorted. */
const canonical = new WeakMap<object, string>();
function planKey(f: RfSectorsFile): string {
  const known = canonical.get(f);
  if (known !== undefined) return known;
  const { file } = splitRfOrigins(f);
  const parsed = RfSectorsFile.safeParse(file);
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, sorted(x)]),
          )
        : v;
  const key = JSON.stringify(sorted(parsed.success ? parsed.data : file));
  canonical.set(f, key);
  return key;
}

/**
 * True when the saved plan is not the plan `run` recorded (`run.inputs.sectors`, the file as the
 * job read it), so the run no longer shows it. Worked out from what is saved, so it reads the same
 * after a reopen. Unsaved edits do not count here (see `dirty`). False without a run or a saved plan.
 */
export function planChangedSince(
  s: Pick<RfState, 'saved'>,
  run: RfRun | null | undefined,
): boolean {
  if (!s.saved || !run) return false;
  return planKey(s.saved) !== planKey(run.inputs.sectors);
}

/** The selected run, else the newest finished one; undefined when there is none. */
export function selectShownRun(s: Pick<RfState, 'runs' | 'selectedRunId'>): RfRun | undefined {
  return s.selectedRunId !== null
    ? s.runs.find((r) => r.runId === s.selectedRunId)
    : s.runs.find((r) => r.status === 'done');
}

/**
 * "The plan changed since this run", for the stage chip and step 3: the saved plan against the
 * selected run (else the newest finished one). See `planChangedSince`.
 */
export function selectPlanChanged(s: Pick<RfState, 'saved' | 'runs' | 'selectedRunId'>): boolean {
  return planChangedSince(s, selectShownRun(s));
}

/** Coverage holds edits that are not saved (the Sectors group's line). */
export function selectUnsavedChanges(s: Pick<RfState, 'dirty' | 'readOnly'>): boolean {
  return s.dirty && !s.readOnly;
}

/** The number of finished coverage runs of the project (the Coverage plan group's count). */
export function selectFinishedRunCount(s: Pick<RfState, 'runs'>): number {
  return s.runs.filter((r) => r.status === 'done').length;
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
  jobSeen = false;
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
    jobSeen = false;
    rfStore.setState({ ...initial(), pack: get().pack, projectId, status: 'loading' });
    set({});
  }
  // a coverage job already going for this project (a reload during a run) holds the run
  watchJobs();
  adoptLiveJob(currentJobs());
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
  // the sidecar's origins merged in; absent ones mean the person set the value
  const onDisk = sec.value.file ? mergeRfOrigins(sec.value.file, sec.value.origins) : null;
  set({
    status: 'ready',
    message: null,
    antennas: ant.value.file,
    readOnly: sec.value.readOnly,
    hasFile: sec.value.file !== null,
    // a read that overlapped a save may be the file from before it: the save sets `saved`
    ...(overlapped ? {} : { saved: onDisk }),
    ...(keep ? {} : { sectors: onDisk ? structuredClone(onDisk) : emptyFile(), dirty: false }),
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

/**
 * Change the working copy and the saved plan by `fn`, and write the saved plan only: the unsaved
 * edits of the working copy stay unsaved (and stay, so nothing typed in Coverage is lost or written
 * behind the person's back). `fn` answers null for a copy it leaves alone. With no plan file, or a
 * saved plan `fn` leaves alone, only the working copy changes (it is then dirty). Answers the
 * write's result, or null when nothing was written.
 */
async function editBoth(
  fn: (f: RfSectorsFile) => RfSectorsFile | null,
): Promise<SaveResult | null> {
  const { readOnly, hasFile, saved, sectors, dirty } = get();
  if (readOnly) return null;
  const working = fn(sectors);
  const disk = hasFile && saved ? fn(saved) : null;
  if (!working && !disk) return null;
  set({
    ...(working ? { sectors: working } : {}),
    ...(disk ? { saved: disk } : {}),
    // still differs from the saved plan by its own edits, or by a change only it took
    dirty: dirty || (working !== null && disk === null),
  });
  return disk ? writePlan('saved') : null;
}

/**
 * Rename a sector: the one rename, from Coverage and from Project's Sectors group. The name shows
 * in both at once; a saved sector is renamed in the saved plan too and that is written, while other
 * unsaved edits stay unsaved. A sector not saved yet is renamed in the working copy. An empty or
 * unchanged name does nothing.
 */
export async function renameSector(sectorId: string, name: string): Promise<SaveResult | null> {
  const n = name.trim();
  if (!n) return null;
  return editBoth((f) =>
    f.sectors.some((s) => s.id === sectorId && s.name !== n)
      ? { ...f, sectors: f.sectors.map((s) => (s.id === sectorId ? { ...s, name: n } : s)) }
      : null,
  );
}

/** The same function as `renameSector` (the Sectors group's name for it). */
export const renameSavedSector = renameSector;

/**
 * Put units back in named sectors (an antenna delete undone): each unit goes into its sector when
 * the unit is in no sector, in the saved plan and in the unsaved copy alike; the saved plan is
 * written, unsaved edits stay unsaved. A sector the delete emptied (and so removed) comes back when
 * the pair names it (`sectorName`); without a name the pair is skipped. `settings`, the unit's RF
 * settings as the delete found them, come back too unless the unit has settings again; a pair
 * with settings and no sector brings back the settings alone. Answers as `editBoth`.
 */
export async function restoreAntennasToSectors(
  pairs: readonly {
    unitId: string;
    sectorId?: string;
    sectorName?: string;
    settings?: RfAntennaSettings;
  }[],
): Promise<SaveResult | null> {
  return editBoth((f) => {
    let changed = false;
    let sectors = f.sectors;
    let antennas = f.antennas;
    for (const { unitId, settings } of pairs) {
      if (!settings || antennas.some((a) => a.antennaId === unitId)) continue;
      antennas = [...antennas, { ...settings, antennaId: unitId }];
      changed = true;
    }
    for (const { unitId, sectorId, sectorName } of pairs) {
      if (sectorId === undefined || sectors.some((s) => s.antennaIds.includes(unitId))) continue;
      const name = sectorName?.trim() ?? '';
      if (sectors.some((s) => s.id === sectorId)) {
        sectors = sectors.map((s) =>
          s.id === sectorId ? { ...s, antennaIds: [...s.antennaIds, unitId] } : s,
        );
      } else if (name !== '') {
        sectors = [...sectors, { id: sectorId, name, antennaIds: [unitId] }];
      } else continue;
      changed = true;
    }
    return changed ? { ...f, sectors, antennas } : null;
  });
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

/**
 * Antennas were deleted from the inventory: take their settings and sector places out of the
 * plan. A saved plan with no edits is changed and saved; a plan with unsaved edits gets the
 * removal in its working copy only (it stays dirty, the person saves it), so nothing typed in
 * Coverage is written behind their back. No plan file, a read-only project, or none of the ids
 * in the plan: nothing happens.
 */
export async function removeAntennasFromPlan(ids: readonly string[]): Promise<void> {
  const { hasFile, readOnly, dirty, sectors } = get();
  if (!hasFile || readOnly) return;
  const held = ids.filter(
    (id) =>
      sectors.antennas.some((a) => a.antennaId === id) ||
      sectors.sectors.some((s) => s.antennaIds.includes(id)),
  );
  if (held.length === 0) return;
  for (const id of held) removeOrphanEntry(id);
  if (!dirty) await saveRf();
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
  return writePlan('working');
}

/**
 * Write the working copy (`working`: it becomes the saved plan) or the saved plan as it is now
 * (`saved`: a change made to both copies; the working copy keeps its own edits). Writes are queued.
 */
function writePlan(which: 'working' | 'saved'): Promise<SaveResult> {
  const run = async (): Promise<SaveResult> => {
    const { projectId, readOnly } = get();
    if (!projectId) return { ok: false, code: 'no-project' };
    if (readOnly) return { ok: false, code: 'read-only' };
    const plan = which === 'working' ? get().sectors : get().saved;
    if (!plan) return { ok: true };
    set({ saving: true });
    // origins go to their sidecar, so rf/sectors.json stays readable by older builds
    const { file, origins } = splitRfOrigins(plan);
    const r = await bridge.call('rf:writeSectors', { projectId, file, origins });
    if (get().projectId !== projectId) return { ok: true };
    if (!r.ok || !r.value.ok) {
      const error = !r.ok ? r.error : r.value.ok ? '' : r.value.error;
      // a change written to the saved plan only is still in the working copy: it can be saved
      set({ saving: false, message: error, ...(which === 'saved' ? { dirty: true } : {}) });
      return { ok: false, code: 'refused', message: error };
    }
    set({
      saving: false,
      message: null,
      hasFile: true,
      writeWarnings: r.value.warnings ?? [],
      // An edit made while the write was in flight stays dirty.
      ...(which === 'working' ? { saved: plan, dirty: get().sectors !== plan } : {}),
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
/**
 * The running job has been in the jobs list: from then on, a list without it means the job is
 * gone (removed, or main forgot it), and the run ends. Before that it may simply not have arrived.
 */
let jobSeen = false;

/** The jobs store, or null where a test mocks the shell with a bridge only. */
function jobsStore(): Pick<typeof jobs, 'subscribe' | 'getState'> | null {
  try {
    const store: Partial<typeof jobs> = jobs;
    return store.subscribe && store.getState
      ? { subscribe: store.subscribe, getState: store.getState }
      : null;
  } catch {
    return null;
  }
}

function currentJobs(): readonly JobRecord[] {
  return jobsStore()?.getState().jobs ?? [];
}

function watchJobs(): void {
  const store = jobsStore();
  if (watchingJobs || !store) return;
  watchingJobs = true;
  store.subscribe((s) => {
    onJobs(s.jobs);
  });
}

/**
 * Take up a coverage job already at work for the open project (the window was reloaded during a
 * run, or the job started elsewhere), so the run shows and a second one cannot start.
 */
function adoptLiveJob(list: readonly JobRecord[]): void {
  const { projectId, running } = get();
  if (running || !projectId) return;
  const project = workspace.getState().project;
  if (project?.id !== projectId) return;
  const job = list.find(
    (j) => j.pipeline === 'rf.coverage' && isActive(j) && sameFolder(j.project, project.root),
  );
  if (!job) return;
  const runId = job.params.runId;
  jobSeen = true;
  set({
    running: true,
    jobId: job.id,
    pendingRunId: typeof runId === 'string' ? runId : null,
    runError: null,
  });
}

function onJobs(list: readonly JobRecord[]): void {
  const { jobId, running, pendingRunId } = get();
  if (!running) {
    adoptLiveJob(list);
    return;
  }
  if (!jobId) return;
  const job = list.find((j) => j.id === jobId);
  if (!job) {
    if (!jobSeen) return;
    jobSeen = false;
    set({ running: false, jobId: null, pendingRunId: null, runError: t('rf.results.runLost') });
    return;
  }
  jobSeen = true;
  if (job.status === 'done') {
    jobSeen = false;
    set({ running: false, jobId: null, pendingRunId: null, runError: null });
    void refreshRuns().then(() => {
      if (pendingRunId && get().runs.some((r) => r.runId === pendingRunId))
        void selectRun(pendingRunId);
    });
  } else if (job.status === 'failed') {
    jobSeen = false;
    set({ running: false, jobId: null, pendingRunId: null, runError: job.error ?? '' });
  } else if (job.status === 'cancelled' || job.status === 'interrupted') {
    jobSeen = false;
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
  const runId = newRunId();
  jobSeen = false;
  set({ running: true, jobId: null, pendingRunId: runId, runError: null });
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
  onJobs(currentJobs());
  return { ok: true, jobId, runId };
}
