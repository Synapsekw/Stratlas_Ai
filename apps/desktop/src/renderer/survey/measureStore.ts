/**
 * Survey measurements in the renderer (M11 G3): the project's `survey/measurements.json` and
 * templates, the active tool and its drawing, the selection, vertex editing and the panels. One
 * geometry model for the 3D site view and the 2D map: site points (E, N, Z) in the project CRS.
 * Autosave is off by default (as Propeller does): changes wait for **Save measurements**.
 */
import {
  type BoundaryEditsFile,
  type ComparisonResult,
  defaultSurveySettings,
  type DesignPickRef,
  emptyMeasurements,
  emptySurveyTemplates,
  MeasurementsFile,
  type MeasurementScope,
  type MeasurementTool,
  type ProjectManifest,
  type SiteMaterial,
  type SitePoint,
  type SurveyMeasurement,
  type SurveySettings,
  type SurveyTemplate,
  type SurveyTemplatesFile,
  type VolumesFile,
} from '@aio/schema';
import {
  changesFile,
  kitDensity,
  openWithKitPiles,
  type KitDensity,
  withKitConversion,
  DEFAULT_SNAP,
  designLayerOptions,
  designRolesOf,
  drawReducer,
  editReducer,
  industryTemplates,
  initialDraw,
  initialEdit,
  isTelecomTool,
  telecomPointCount,
  telecomProblem,
  flipFace,
  kitBaseLabel,
  kitConversion,
  measurementFrom,
  MIN_POINTS,
  missingRoles,
  needsHeightRepair,
  primaryRow,
  repairKitHeights,
  seriesKeyOf,
  removeTemplate,
  templateLibrary,
  TOOL_FAMILY,
  TOOL_LABELS,
  upsertTemplate,
  validPicks,
  type DesignLayerOption,
  type DrawEnv,
  type DrawEvent,
  type DrawState,
  type EditEvent,
  type EditState,
  type HeightSampler,
  type KitHeightAt,
  type RolePicks,
  type SnapSettings,
  type SnapSource,
} from '@aio/survey';
import { t } from '@aio/ui';
import { shiftKey, workspace } from '@aio/workspace';
import { createStore, useStore } from 'zustand';
import { authorName } from '../author';
import { bridge } from '../shell';
import { timeline } from '../workspace/timeline';
import { rowText } from './card/cardModel';
import { designs, loadDesigns } from './designsStore';
import {
  captureOfEpoch,
  dsmOnly,
  epochOfPile,
  fetchKitText,
  kitDsmHeightAt,
  kitEpochs,
  kitEpochsWanted,
  kitRepairHeights,
  wantsKitHeights,
  type DsmCache,
} from './kitHeights';
import { drawnPoints, scopeShift, storedPoints } from './measureDates';
import { editedOutline, outlineEdit } from './measureMove';
import { alignPicks, creationDating, realignPickedOn, type VertexPick } from './measureSource';
import {
  createMeasureVisibilityMemory,
  measureStorage,
  type MeasureVisibilityMemory,
} from './measureVisibility';

export type MeasureDialog =
  | { kind: 'units'; target: 'site' | 'measurement' }
  | { kind: 'templates'; edit: string | null; scope: 'project' | 'user' }
  | null;

export interface ActiveTool {
  tool: MeasurementTool;
  template: SurveyTemplate | null;
  /** The site's design layers for the template's roles (`SurveySettings.designRoles`). */
  picks: RolePicks;
  /** A one-shot drawing for another tool: what to draw, said in the drawing bar. */
  prompt?: string;
  /** Called with the finished measurement; the tool then stops (one shape only). */
  then?: (m: SurveyMeasurement) => void;
  /**
   * Measure without saving (D19): a finished shape stays on the canvas with its reading and is
   * never added to the project. Read-only projects and packages always measure this way.
   */
  transient?: boolean;
}

/** How a tool starts: a template, a one-shot drawing for another tool, or without saving. */
export interface StartToolOptions {
  template?: SurveyTemplate | null;
  forOther?: DrawFor;
  transient?: boolean;
}

/** The tools that read without saving, so they work in a read-only project too (D6). */
const READS_WITHOUT_SAVING: ReadonlySet<MeasurementTool> = new Set(['distance']);

/** A one-shot drawing: the prompt shown while drawing and what to do with the shape. */
export interface DrawFor {
  prompt: string;
  then: (m: SurveyMeasurement) => void;
}

/**
 * A template that compares to a design asks, the first time it is used on a site, which design
 * surface layer each of its roles means (G9's industry sets: `og`, `subgrade`, `final-cap`).
 */
export interface RolePrompt {
  template: SurveyTemplate;
  roles: DesignPickRef[];
  options: DesignLayerOption[];
  /** The site's picks that still hold (kept with the answer). */
  picks: RolePicks;
  then: (picks: RolePicks) => void;
  error: string | null;
}

/**
 * A short line about measurements in the sidebar's note slot (a date move, a refusal). `undo`
 * offers Undo (`undoMeasureChange(seq)`), `prepare` offers Prepare surfaces.
 */
export interface MeasureNote {
  seq: number;
  text: string;
  danger: boolean;
  undo?: boolean;
  prepare?: boolean;
}

/** Measurements a deletion took out, each with its index in the file before it. */
export interface UndoDelete {
  items: { m: SurveyMeasurement; index: number }[];
  seq: number;
}

export interface MeasureState {
  projectId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Saving is refused (a package): measurements are shown, never written. */
  readOnly: boolean;
  file: MeasurementsFile;
  /**
   * The file as last read or saved, to tell a person's unsaved changes. Results the app computed
   * on its own are put on it too (`setComputedResults`), so they never count as an edit.
   */
  savedText: string;
  /** Results the app computed are not on disk yet (written with the next save). */
  resultsUnwritten: boolean;
  saving: boolean;
  /** A short line after a save or a refusal. */
  message: string | null;
  autosave: boolean;
  settings: SurveySettings;
  /** The stockpile kit's density and material names, for its piles' tonnes; null without kit data. */
  kitDensity: KitDensity | null;
  /** The site settings came from `survey/settings.json` (false: the defaults). */
  settingsExist: boolean;
  templates: { project: SurveyTemplatesFile | null; user: SurveyTemplatesFile };
  tool: ActiveTool | null;
  draw: DrawState | null;
  selected: string[];
  /** The measurement the panel shows. */
  focus: string | null;
  editing: EditState | null;
  /**
   * Always true: the one switch for every saved measurement is gone (the tree's eyes hide them one
   * by one, `hiddenMeasurements`). Kept read-only, and typed `boolean`, for the readers that still
   * compare it.
   */
  readonly measurementsVisible: boolean;
  /** Saved measurements hidden one by one in the views (the eye on their row; view only). */
  hiddenMeasurements: readonly string[];
  /**
   * The deletions that can still be undone, oldest first and at most `UNDO_DELETES`: the
   * deleted measurements with where each stood in the file (`seq` makes each deletion new).
   * Undo takes back the last one, then the one before it; Dismiss lets go of them all.
   */
  undoDeletes: readonly UndoDelete[];
  /** The tree is asked to scroll to and select a measurement (`seq` makes each ask new). */
  reveal: { id: string | null; seq: number; openSidebar: boolean } | null;
  /** The tree is asked to open an inline new-folder row for these measurements. */
  newFolder: { ids: string[]; seq: number } | null;
  dialog: MeasureDialog;
  snap: SnapSettings;
  /** The surface readouts sample (the 3D view's terrain until G2's prepared surfaces). */
  surface: HeightSampler | null;
  /** Asking for the design layers of a template's roles before it is used. */
  rolePrompt: RolePrompt | null;
  /** The note the sidebar shows about measurements (null: none). */
  note: MeasureNote | null;
  /** The last undoable replacement (a date move): the measurements as they were before it. */
  undoChange: { seq: number; before: SurveyMeasurement[] } | null;
}

const now = () => new Date().toISOString();
const openManifest = () => workspace.getState().project?.manifest ?? null;

/**
 * Edited (drawn) points as they are saved: the date's shift subtracted. A vertex that was not
 * moved keeps its stored value exactly, so adding and taking off the shift does not drift it.
 */
function savedEdit(
  edited: readonly SitePoint[],
  m: SurveyMeasurement,
  manifest: ReturnType<typeof openManifest>,
): SitePoint[] {
  const was = new Map<string, SitePoint>();
  const drawn = drawnPoints(m, manifest);
  drawn.forEach((p, i) => {
    const kept = m.points[i];
    if (kept) was.set(p.join(','), kept);
  });
  return edited.map((p) => was.get(p.join(',')) ?? storedPoints([p], m.scope, manifest)[0] ?? p);
}
const text = (f: MeasurementsFile) => JSON.stringify(f);

/** What each vertex of the drawing in progress was picked on (one entry per drawn point). */
let drawPicks: VertexPick[] = [];

let counter = 0;
/** A new file-name-safe measurement id. */
export function newMeasurementId(): string {
  counter = (counter + 1) % 1296;
  return `m${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}`;
}

const initial = (): Omit<MeasureState, 'snap' | 'autosave' | 'surface'> => ({
  projectId: null,
  status: 'idle',
  error: null,
  readOnly: false,
  file: emptyMeasurements(),
  savedText: text(emptyMeasurements()),
  resultsUnwritten: false,
  saving: false,
  message: null,
  settings: defaultSurveySettings(),
  kitDensity: null,
  settingsExist: false,
  templates: { project: null, user: emptySurveyTemplates() },
  tool: null,
  draw: null,
  selected: [],
  focus: null,
  editing: null,
  measurementsVisible: true,
  hiddenMeasurements: [],
  undoDeletes: [],
  reveal: null,
  newFolder: null,
  dialog: null,
  rolePrompt: null,
  note: null,
  undoChange: null,
});

export const measureStore = createStore<MeasureState>()(() => ({
  ...initial(),
  autosave: false,
  snap: DEFAULT_SNAP,
  surface: null,
}));

export function setSurface(surface: HeightSampler | null): void {
  set({ surface });
}

export function useMeasure<T>(selector: (s: MeasureState) => T): T {
  return useStore(measureStore, selector);
}

const set = (patch: Partial<MeasureState>) => {
  measureStore.setState(patch);
};
const get = () => measureStore.getState();

let visibilityMemory: MeasureVisibilityMemory = createMeasureVisibilityMemory(measureStorage());
/** Replace where hidden ids are remembered (tests). */
export function setMeasureVisibilityMemory(m: MeasureVisibilityMemory): void {
  visibilityMemory = m;
}
let revealSeq = 0;
let undoSeq = 0;
/** How many deletions stay undoable. */
export const UNDO_DELETES = 10;
/**
 * Bumped by every load that resets the state: a save or an earlier load that awaited across one
 * (A, then B, then A again) finds it changed and leaves the new load alone, though the project id
 * is the same.
 */
let loadEpoch = 0;
/**
 * Each project's writes still in flight, chained, settled whether they wrote or not: a load of
 * that project waits for them, so it never reads the file from before a write that lands after.
 */
const writing = new Map<string, Promise<unknown>>();
/**
 * Projects open with the kit-pile mark in memory only: opening writes nothing without kit data to
 * convert, so the mark goes with the first save, or when a stockpile build starts.
 */
const markUnwritten = new Set<string>();
/** Forget the writes in flight (tests: a gate a test left shut must not hold the next one's load). */
export function forgetMeasureWrites(): void {
  writing.clear();
}
/**
 * The kit DSMs decoded for one project, kept while it is the one opened (a reopen, a repair after
 * each prepare job decode nothing again); another project's open lets them go.
 */
let kitDsms: { projectId: string; cache: DsmCache } | null = null;
function kitDsmCache(projectId: string): DsmCache {
  if (kitDsms?.projectId !== projectId) kitDsms = { projectId, cache: new Map() };
  return kitDsms.cache;
}
/** Let go of the decoded kit DSMs (a volumetric build wrote them again; tests). */
export function forgetKitDsms(): void {
  kitDsms = null;
  repairFoundNothing = null;
}
/**
 * The last repair that found no height for any pile still at Z 0: what it looked at (the prepared
 * surfaces, the piles), so the same look is not made again until one of them changes.
 */
let repairFoundNothing: { projectId: string; epoch: number; key: string } | null = null;
let newFolderSeq = 0;
/** Seq of undoable replacements and of measurement notes (one counter: each is new). */
let changeSeq = 0;

export const isDirty = (s: Pick<MeasureState, 'file' | 'savedText'>): boolean =>
  text(s.file) !== s.savedText;

// ---------------------------------------------------------------- loading and saving

/** Read the project's measurements, templates and site settings. */
export async function loadMeasurements(projectId: string | null): Promise<void> {
  if (projectId === get().projectId && get().status !== 'error') return;
  const epoch = ++loadEpoch;
  set({ ...initial(), projectId, status: projectId ? 'loading' : 'idle' });
  if (kitDsms?.projectId !== projectId) kitDsms = null;
  if (!projectId) return;
  const pending = writing.get(projectId);
  if (pending) {
    await pending;
    if (loadEpoch !== epoch) return;
  }
  const [m, t, s, v] = await Promise.all([
    bridge.call('survey:readMeasurements', { projectId }),
    bridge.call('survey:readTemplates', { projectId }),
    bridge.call('survey:readSettings', { projectId }),
    bridge.call('project:readVolumes', { projectId }),
  ]);
  // a later load (of another project, or of this one again) owns the state now
  if (loadEpoch !== epoch) return;
  if (!m.ok || !m.value.ok) {
    const error = !m.ok ? m.error : m.value.ok ? '' : m.value.error;
    set({ status: 'error', error });
    return;
  }
  // hidden ids are remembered per project; ones no longer in the file are dropped
  const remembered = visibilityMemory.load(projectId);
  const present = new Set(m.value.file.measurements.map((x) => x.id));
  const hidden = remembered.filter((id) => present.has(id));
  if (hidden.length < remembered.length) visibilityMemory.save(projectId, hidden);
  const readOnly = m.value.readOnly;
  const materials = s.ok && s.value.ok ? s.value.settings.materials : [];
  const read = v.ok && v.value.ok ? v.value : null;
  const manifest = manifestOf(projectId);
  // the kit's DSMs, read only when a pile is to convert or still lies at Z 0, and only those of
  // their dates (decoded once per project, `kitDsmCache`)
  const heightAt =
    read?.volumes && manifest && wantsKitHeights(m.value.file, read.volumes)
      ? await kitDsmHeightAt(
          projectId,
          kitEpochsWanted(m.value.file, read.volumes, read.edits),
          fetchKitText,
          { volumes: read.volumes, cache: kitDsmCache(projectId) },
        )
      : undefined;
  if (loadEpoch !== epoch) return;
  // old stockpile kit piles open as volume measurements with their figures (W3): a conversion,
  // not an edit, so the baseline takes it too and nothing shows as unsaved
  const opened = openedWithKitPiles(m.value.file, read, manifest, materials, readOnly, heightAt);
  const converted = opened !== m.value.file;
  // kit piles a build before per-date outlines converted take theirs once (`kitOutlinesAdded`
  // grew); a new conversion always lists its piles afresh (`kitPilesConverted`)
  const newlyConverted = opened.kitPilesConverted !== m.value.file.kitPilesConverted;
  const outlinesAdded = (opened.kitOutlinesAdded ?? []).slice(
    m.value.file.kitOutlinesAdded?.length ?? 0,
  );
  // piles converted at Z 0 before heights take them once (a migration, like the conversion); the
  // prepared surfaces are not read yet: `repairKitHeightsNow` asks them once they exist
  const { file, repaired } =
    heightAt && manifest && read?.volumes
      ? repairKitHeights(
          opened,
          await kitRepairHeights(opened, manifest, dsmOnly(read.volumes, heightAt, read.edits)),
        )
      : { file: opened, repaired: [] };
  if (loadEpoch !== epoch) return;
  // only old kit data is converted on disk at once; a mark alone stays in memory
  const kitRead = read?.volumes != null;
  if (converted && !readOnly && !kitRead) markUnwritten.add(projectId);
  else markUnwritten.delete(projectId);
  const write = !readOnly && ((converted && kitRead) || repaired.length > 0);
  const patch: Partial<MeasureState> = {
    status: 'ready',
    file,
    savedText: text(file),
    readOnly,
    hiddenMeasurements: hidden,
    ...(write ? { resultsUnwritten: true } : {}),
  };
  if (t.ok && t.value.ok) patch.templates = { project: t.value.project, user: t.value.user };
  // site settings are G1's; until they exist the defaults hold (metres)
  if (s.ok && s.value.ok) {
    patch.settings = s.value.settings;
    patch.settingsExist = s.value.exists;
  }
  // a kit pile weighs by the kit's density unless the person picked a site material (`pileMaterial`)
  patch.kitDensity = kitDensity(read?.volumes ?? null);
  set(patch);
  // a writable project keeps the conversion on disk at once; a package keeps it in memory only
  if (write)
    await writeConversion(
      projectId,
      file,
      epoch,
      newlyConverted && kitRead
        ? migrationCommands(file, 'audit.migration.kitConverted')
        : [
            ...(repaired.length > 0 ? migrationCommands(file, 'audit.migration.kitHeights') : []),
            ...(outlinesAdded.length > 0
              ? [{ label: kitOutlinesLabel(), ids: outlinesAdded.slice(0, COMMAND_IDS_MAX) }]
              : []),
          ],
    );
}

/** The journal label of the one-time fill of per-date outlines (volumetric report, bug 1). */
const kitOutlinesLabel = (): string => t('audit.migration.kitOutlines');

const folderKey = (root: string) => root.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

/**
 * A job is about to start (the pipeline dialog, the new project wizard): a stockpile build of the
 * open project marks it (`markForStockpileBuild`). Another pipeline, or a folder that is not the
 * open project, is left alone.
 */
export async function markBeforeBuild(pipeline: string, root: string): Promise<void> {
  if (pipeline !== 'volumetric.build') return;
  const p = workspace.getState().project;
  if (!p || folderKey(p.root) !== folderKey(root)) return;
  await markForStockpileBuild(p.id);
}

/**
 * A stockpile build (`volumetric.build`) is about to start: a project with no kit data yet gets
 * the kit-pile mark on disk, so piles the build adds are never taken for an old project's, even
 * when the project is closed before the build ends. The open project writes its baseline as last
 * saved (never a person's unsaved edits); one not loaded here has its file marked as it is.
 */
export async function markForStockpileBuild(projectId: string): Promise<void> {
  const s0 = get();
  if (s0.projectId === projectId && s0.status === 'ready') {
    if (s0.readOnly || !markUnwritten.has(projectId)) return;
    const epoch = loadEpoch;
    if (!(await writesSettled(projectId))) return;
    const s = get();
    if (loadEpoch !== epoch || s.projectId !== projectId || !markUnwritten.has(projectId)) return;
    const baseline = JSON.parse(s.savedText) as MeasurementsFile;
    const r = await writeFile(projectId, baseline);
    if (r.ok && r.value.ok) markUnwritten.delete(projectId);
    return;
  }
  const [m, v] = await Promise.all([
    bridge.call('survey:readMeasurements', { projectId }),
    bridge.call('project:readVolumes', { projectId }),
  ]);
  if (!m.ok || !m.value.ok || m.value.readOnly) return;
  if (!v.ok || !v.value.ok || v.value.volumes) return;
  if (m.value.file.kitPilesConverted !== undefined) return;
  await writeFile(projectId, { ...m.value.file, kitPilesConverted: [] });
}

/** The open project's manifest, when it is this project's. */
function manifestOf(projectId: string): ProjectManifest | null {
  const p = workspace.getState().project;
  return p?.id === projectId ? p.manifest : null;
}

/** How kit piles are placed and named in this project (`@aio/survey` `KitOpenOptions`). */
const kitOptions = (
  origin: readonly number[],
  materials: readonly SiteMaterial[],
  heightAt?: KitHeightAt,
) => ({
  origin,
  materials,
  now: now(),
  newId: newMeasurementId,
  // converted outlines are draped on the kit's DSM of their date
  ...(heightAt ? { heightAt } : {}),
});

/**
 * The file as it opens (`openWithKitPiles`, the one rule the report and the assistant use too):
 * kit piles not converted yet added, their kit figures carried only when the file has never been
 * converted. Without the volumes read, or without the manifest the kit's frame hangs from, the
 * file as it is.
 */
function openedWithKitPiles(
  file: MeasurementsFile,
  read: { volumes: VolumesFile | null; edits: BoundaryEditsFile | null } | null,
  manifest: ProjectManifest | null,
  materials: readonly SiteMaterial[],
  readOnly: boolean,
  heightAt?: KitHeightAt,
): MeasurementsFile {
  if (!read) return file;
  if (read.volumes && !manifest) return file;
  return openWithKitPiles(file, read, {
    ...kitOptions(manifest?.origin ?? [0, 0, 0], materials, heightAt),
    readOnly,
  });
}

/**
 * Write a converted file: the baseline as saved plus the conversion, never a person's unsaved
 * edits. `saving` holds while it is in flight, so no save starts and lands before it. A refused
 * write says so as a refused save does, and the conversion stays to be written by the next save.
 * `label` names every record the write changes; labelled commands name only theirs.
 */
async function writeConversion(
  projectId: string,
  file: MeasurementsFile,
  epoch: number,
  label: MigrationLabel | { label: string; ids: string[] }[],
): Promise<void> {
  set({ saving: true });
  const commands = typeof label === 'string' ? migrationCommands(file, label) : label;
  const r = await writeFile(projectId, file, commands);
  if (r.ok && r.value.ok && file.kitPilesConverted !== undefined) markUnwritten.delete(projectId);
  if (loadEpoch !== epoch || get().projectId !== projectId) return;
  const ok = r.ok && r.value.ok;
  const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
  set({
    saving: false,
    ...(ok
      ? get().savedText === text(file)
        ? { resultsUnwritten: false }
        : {}
      : { message: `Not saved: ${error ?? ''}`, resultsUnwritten: true }),
  });
  if (ok && get().autosave && get().status === 'ready' && isDirty(get())) void saveMeasurements();
}

/** Wait until no write of the project is in flight (a person's save lands first). */
export async function writesSettled(projectId: string): Promise<boolean> {
  for (let p = writing.get(projectId); p; p = writing.get(projectId)) await p;
  return !get().saving;
}

/**
 * After a volumetric build: piles the build added become volume measurements without a carried
 * figure (the engine computes theirs on demand, so nothing old is silently replaced). Written at
 * once with the file as last saved, after any save in flight; the person's unsaved edits stay
 * unsaved.
 */
export async function convertAfterJob(projectId: string): Promise<void> {
  const s0 = get();
  if (s0.projectId !== projectId || s0.status !== 'ready' || s0.readOnly) return;
  const manifest = manifestOf(projectId);
  if (!manifest) return;
  const epoch = loadEpoch;
  const r = await bridge.call('project:readVolumes', { projectId });
  const built = r.ok && r.value.ok ? r.value.volumes : null;
  // the build wrote the kit's DSMs again: none decoded before it holds
  forgetKitDsms();
  const heightAt = built
    ? await kitDsmHeightAt(projectId, kitEpochs(built), fetchKitText, {
        volumes: built,
        cache: kitDsmCache(projectId),
      })
    : undefined;
  // a save in flight lands first, and the conversion goes on the baseline it leaves
  if (!(await writesSettled(projectId))) return;
  const s = get();
  if (loadEpoch !== epoch || s.projectId !== projectId || s.status !== 'ready' || s.readOnly)
    return;
  if (!r.ok || !r.value.ok || !r.value.volumes) return;
  const c = kitConversion(s.file, r.value.volumes, r.value.edits, false, {
    ...kitOptions(manifest.origin, s.settings.materials, heightAt),
    rebuilt: true,
  });
  if (!changesFile(c) && s.file.kitPilesConverted !== undefined) return;
  const baseline = withKitConversion(JSON.parse(s.savedText) as MeasurementsFile, c);
  const file = withKitConversion(s.file, c);
  set({
    file,
    savedText: text(baseline),
    resultsUnwritten: true,
    kitDensity: kitDensity(r.value.volumes),
  });
  await writeConversion(projectId, baseline, epoch, 'audit.migration.kitBuilt');
}

/**
 * The heights of a repair kept only for the measurements in `file` that still need one and still
 * have the outline the heights were found for (in `from`): a pile edited meanwhile is left alone.
 */
function heightsStillFor(
  file: MeasurementsFile,
  from: MeasurementsFile,
  heights: ReadonlyMap<string, number[]>,
): Map<string, number[]> {
  const was = new Map(from.measurements.map((m) => [m.id, JSON.stringify(m.points)]));
  const out = new Map<string, number[]>();
  for (const m of file.measurements) {
    const z = heights.get(m.id);
    if (!z || !needsHeightRepair(m, file)) continue;
    if (was.get(m.id) === JSON.stringify(m.points)) out.set(m.id, z);
  }
  return out;
}

/**
 * A repair outlives Undo: the undoable replacement's measurements as they were (`undoChange`) and
 * as it left them (`undoAfter`) take the repaired heights too, where they still lie at Z 0 on the
 * same outline. Else an Undo put Z 0 back while the id stayed listed as repaired, and the repair
 * itself read as an edit that let go of the undo.
 */
function repairedInUndo(
  s: MeasureState,
  file: MeasurementsFile,
  repaired: readonly string[],
): Partial<MeasureState> {
  if (!s.undoChange) return {};
  const ids = new Set(repaired);
  const fixed = new Map(file.measurements.filter((m) => ids.has(m.id)).map((m) => [m.id, m]));
  const heighted = (m: SurveyMeasurement): SurveyMeasurement => {
    const r = fixed.get(m.id);
    if (r?.points.length !== m.points.length) return m;
    const same = m.points.every((p, i) => {
      const q = r.points[i];
      return q !== undefined && p[2] === 0 && p[0] === q[0] && p[1] === q[1];
    });
    return same ? { ...m, points: r.points } : m;
  };
  for (const id of ids) {
    const r = fixed.get(id);
    if (r && undoAfter.has(id)) undoAfter.set(id, asReplaced(r));
  }
  return { undoChange: { ...s.undoChange, before: s.undoChange.before.map(heighted) } };
}

/**
 * Give the open project's converted piles that still lie at Z 0 their real heights: the kit's
 * DSM of their date, else that date's prepared surface (so it is worth asking again once surfaces
 * are prepared). A migration like the conversion: written quietly with the file as last saved in a
 * writable project (the person's unsaved edits stay unsaved), in memory only in a read-only one,
 * never shown as unsaved. Returns the ids repaired.
 */
export async function repairKitHeightsNow(projectId: string): Promise<string[]> {
  const s0 = get();
  const manifest = manifestOf(projectId);
  if (s0.projectId !== projectId || s0.status !== 'ready' || !manifest) return [];
  const needing = s0.file.measurements
    .filter((m) => needsHeightRepair(m, s0.file))
    .map((m) => m.id);
  if (needing.length === 0) return [];
  const epoch = loadEpoch;
  // loaded when asked: the prepared surfaces' module reads the compare store, which reads this one
  const [{ groundAt }, { compareStore }] = await Promise.all([
    import('./dateSurfaces'),
    import('./compareStore'),
  ]);
  // the same look that found nothing before (each prepare job's end reads the surfaces again,
  // often unchanged) is not made again
  const key = JSON.stringify([compareStore.getState().surfaces, needing]);
  const nothing = repairFoundNothing;
  if (nothing?.projectId === projectId && nothing.epoch === epoch && nothing.key === key) return [];
  const r = await bridge.call('project:readVolumes', { projectId });
  const volumes = r.ok && r.value.ok ? r.value.volumes : null;
  const edits = r.ok && r.value.ok ? r.value.edits : null;
  const dsm = await kitDsmHeightAt(
    projectId,
    volumes ? kitEpochsWanted(s0.file, volumes, edits) : [],
    fetchKitText,
    { volumes, cache: kitDsmCache(projectId) },
  );
  const heights = await kitRepairHeights(s0.file, manifest, {
    dsm,
    groundAt,
    captureOfEpoch: captureOfEpoch(volumes),
    epochOfPile: epochOfPile(volumes, edits),
  });
  if (heights.size === 0) {
    if (loadEpoch === epoch) repairFoundNothing = { projectId, epoch, key };
    return [];
  }
  // a save in flight lands first, and the repair goes on the baseline it leaves
  if (!(await writesSettled(projectId))) return [];
  const s = get();
  if (loadEpoch !== epoch || s.projectId !== projectId || s.status !== 'ready') return [];
  const current = repairKitHeights(s.file, heightsStillFor(s.file, s0.file, heights));
  if (current.repaired.length === 0) return [];
  const saved = JSON.parse(s.savedText) as MeasurementsFile;
  const baseline = repairKitHeights(saved, heightsStillFor(saved, s0.file, heights));
  set({
    file: current.file,
    savedText: text(baseline.file),
    ...(s.readOnly ? {} : { resultsUnwritten: true }),
    ...repairedInUndo(s, current.file, current.repaired),
  });
  if (!s.readOnly && baseline.repaired.length > 0)
    await writeConversion(projectId, baseline.file, epoch, 'audit.migration.kitHeights');
  return current.repaired;
}

/** A converted pile still holding a carried kit figure (headline or over time). */
const holdsCarried = (m: SurveyMeasurement): boolean =>
  m.results.some((r) => r.carried !== undefined) ||
  (m.series ?? []).some((r) => r.carried !== undefined);

/** `m` with the accepted pile's figures: results, was and dates (no edit, `updatedAt` stays). */
function withAccepted(m: SurveyMeasurement, a: SurveyMeasurement): SurveyMeasurement {
  const next: SurveyMeasurement = { ...m, results: a.results };
  if (a.previousResults) next.previousResults = a.previousResults;
  if (a.series) next.series = a.series;
  else delete next.series;
  return next;
}

/**
 * What a measurement's figures are computed from: its items (their labels aside), the survey it is
 * scoped to and, with `withRing`, its outline and each survey date's own (`outlines`). Figures
 * computed for one key belong to no other.
 */
export const measureInputsKey = (m: SurveyMeasurement, withRing = true): string =>
  JSON.stringify([
    m.items.map((it) => ({ ...it, label: undefined })),
    m.scope.kind === 'survey' ? m.scope.capture : null,
    withRing ? m.points.map((p) => [p[0], p[1]]) : null,
    // only when there are any, so a measurement without them keeps the key it had
    ...(withRing && m.outlines?.length
      ? [m.outlines.map((o) => [o.capture, o.points.map((p) => [p[0], p[1]])])]
      : []),
  ]);

/** A pile the app accepted, with the inputs (`measureInputsKey`) its figures were computed from. */
export interface KitAccepted {
  m: SurveyMeasurement;
  key: string;
}

/**
 * Converted piles the app accepted with the standard base on its own once their surfaces were
 * ready (`acceptCarriedQuietly`, ADR 0013 point 4): a migration like the conversion, not an edit.
 * The figures (with the kit's as was) go on the file and on the baseline as last saved, written
 * quietly with the baseline (a person's unsaved edits stay unsaved and unwritten), never an undo
 * step and never shown as unsaved. Each version (the file, the baseline) takes them only while it
 * still holds the carried figure and the inputs they were computed from: a vertex moved and not
 * saved, or an edit made while the piles were computed one by one, keeps that version as it is.
 * Nothing in a read-only project. Returns the ids taken in the file.
 */
export async function acceptKitQuietly(
  projectId: string,
  accepted: readonly KitAccepted[],
): Promise<string[]> {
  if (accepted.length === 0) return [];
  const epoch = loadEpoch;
  // a save in flight lands first, and the acceptance goes on the baseline it leaves
  if (!(await writesSettled(projectId))) return [];
  const s = get();
  if (loadEpoch !== epoch || s.projectId !== projectId || s.status !== 'ready' || s.readOnly)
    return [];
  const byId = new Map(accepted.map((a) => [a.m.id, a]));
  const takes = (m: SurveyMeasurement): SurveyMeasurement | null => {
    const a = byId.get(m.id);
    return a && holdsCarried(m) && measureInputsKey(m) === a.key ? a.m : null;
  };
  const taken: string[] = [];
  const file: MeasurementsFile = {
    ...s.file,
    measurements: s.file.measurements.map((m) => {
      const a = takes(m);
      if (!a) return m;
      taken.push(m.id);
      return withAccepted(m, a);
    }),
  };
  const saved = JSON.parse(s.savedText) as MeasurementsFile;
  let onBaseline = 0;
  const baseline: MeasurementsFile = {
    ...saved,
    measurements: saved.measurements.map((m) => {
      const a = takes(m);
      if (!a) return m;
      onBaseline++;
      return withAccepted(m, a);
    }),
  };
  if (taken.length === 0 && onBaseline === 0) return [];
  if (onBaseline === 0) {
    // only the person's unsaved version took them: written with their next save
    set({ file });
    return taken;
  }
  set({ file, savedText: text(baseline), resultsUnwritten: true });
  await writeConversion(projectId, baseline, epoch, 'audit.migration.kitAccepted');
  return taken;
}

/** The journal label of each of the app's own migrations of old kit piles. */
type MigrationLabel =
  | 'audit.migration.kitConverted'
  | 'audit.migration.kitBuilt'
  | 'audit.migration.kitHeights'
  | 'audit.migration.kitAccepted';

/** An `EditCommand` id list holds at most this many ids (`@aio/schema`). */
const COMMAND_IDS_MAX = 10_000;

/**
 * The labelled commands of a migration's write: it is written on the file as last saved, so every
 * record the write changes is the migration's, and History names it rather than "Measurement
 * edited" (a migration, not a person's edit).
 */
export function migrationCommands(
  file: MeasurementsFile,
  key: MigrationLabel,
): { label: string; ids: string[] }[] {
  const label = t(key);
  const ids = file.measurements.map((m) => m.id);
  const out: { label: string; ids: string[] }[] = [];
  for (let i = 0; i < ids.length; i += COMMAND_IDS_MAX)
    out.push({ label, ids: ids.slice(i, i + COMMAND_IDS_MAX) });
  return out;
}

/** Write the file, chained after the project's writes in flight (a load waits for them). */
function writeFile(
  projectId: string,
  file: MeasurementsFile,
  commands?: { label: string; ids: string[] }[],
) {
  const write = bridge.call('survey:writeMeasurements', {
    projectId,
    file,
    ...(commands?.length ? { commands } : {}),
  });
  const chain = Promise.allSettled([writing.get(projectId), write]);
  writing.set(projectId, chain);
  void chain.then(() => {
    if (writing.get(projectId) === chain) writing.delete(projectId);
  });
  return write;
}

export async function saveMeasurements(): Promise<boolean> {
  const s = get();
  // only a file read in full is written: never the empty one of a load still under way or failed
  if (!s.projectId || s.status !== 'ready' || s.readOnly || s.saving) return false;
  const file = s.file;
  const projectId = s.projectId;
  const epoch = loadEpoch;
  set({ saving: true, message: null });
  const r = await writeFile(projectId, file);
  if (r.ok && r.value.ok && file.kitPilesConverted !== undefined) markUnwritten.delete(projectId);
  // another project (or this one again) was opened meanwhile: that state is not this save's to
  // touch, or to save
  if (loadEpoch !== epoch || get().projectId !== projectId) return false;
  const ok = r.ok && r.value.ok;
  const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
  set({
    saving: false,
    message: ok ? 'Measurements saved.' : `Not saved: ${error ?? ''}`,
    ...(ok ? { savedText: text(file) } : {}),
    ...(ok && get().file === file ? { resultsUnwritten: false } : {}),
  });
  // an edit made while this save was in flight (an Undo right after a Delete) is saved too
  if (ok && get().autosave && get().status === 'ready' && isDirty(get())) void saveMeasurements();
  return ok;
}

/** Put the file back as it was last saved. */
export function revertMeasurements(): void {
  const s = get();
  const parsed = MeasurementsFile.safeParse(JSON.parse(s.savedText));
  // the baseline as parsed too (its key order), so the reverted file reads as saved
  if (parsed.success)
    set({
      file: parsed.data,
      savedText: text(parsed.data),
      selected: [],
      focus: null,
      editing: null,
      message: null,
      ...dropUndo(s),
      undoDeletes: s.undoDeletes.flatMap((u) => {
        const left = undoLeft(u, parsed.data);
        return left ? [left] : [];
      }),
    });
}

/** What an undo still has to bring back: the deleted measurements not in `file` again. */
function undoLeft(u: UndoDelete | undefined, file: MeasurementsFile): UndoDelete | null {
  if (!u) return null;
  const present = new Set(file.measurements.map((m) => m.id));
  const items = u.items.filter((x) => !present.has(x.m.id));
  return items.length === 0 ? null : { ...u, items };
}

/**
 * A measurement as an undoable replacement left it: everything but its computed results. The
 * figures over time and the kit figures kept as "was" count as results too: the recompute after a
 * date move may accept the standard base in place of a carried kit figure, and Undo puts that back.
 */
const asReplaced = (m: SurveyMeasurement | undefined): string =>
  m
    ? JSON.stringify({
        ...m,
        results: undefined,
        series: undefined,
        previousResults: undefined,
        updatedAt: undefined,
      })
    : '';

/** The measurements as the undoable replacement left them, by id (with `undoChange`). */
let undoAfter = new Map<string, string>();

/** The patch that lets go of the undo (its note stays, without Undo). */
function dropUndo(s: MeasureState): Partial<MeasureState> {
  if (!s.undoChange) return {};
  const seq = s.undoChange.seq;
  if (s.note?.seq !== seq || !s.note.undo) return { undoChange: null };
  const note = { ...s.note };
  delete note.undo;
  return { undoChange: null, note };
}

/**
 * A person's edit (or a follow) to a measurement the undoable replacement changed lets go of that
 * undo, so Undo never puts back an older version over it. Recomputed results do not count.
 */
function undoAfterEdit(file: MeasurementsFile): Partial<MeasureState> {
  const s = get();
  if (!s.undoChange) return {};
  const now = new Map(file.measurements.map((m) => [m.id, m]));
  for (const [id, was] of undoAfter) if (asReplaced(now.get(id)) !== was) return dropUndo(s);
  return {};
}

function changed(file: MeasurementsFile, extra: Partial<MeasureState> = {}): void {
  const undo = 'undoChange' in extra ? {} : undoAfterEdit(file);
  set({ file, message: null, ...undo, ...extra });
  if (get().autosave) void saveMeasurements();
}

// ---------------------------------------------------------------- measurements

export function patchMeasurement(id: string, patch: Partial<SurveyMeasurement>): void {
  const s = get();
  if (s.readOnly) return;
  changed({
    ...s.file,
    measurements: s.file.measurements.map((m) =>
      m.id === id ? { ...m, ...patch, updatedAt: now() } : m,
    ),
  });
}

/** Replace one measurement as a whole (fields removed stay removed). */
export function replaceMeasurement(m: SurveyMeasurement): void {
  const s = get();
  if (s.readOnly) return;
  changed({
    ...s.file,
    measurements: s.file.measurements.map((x) => (x.id === m.id ? { ...m, updatedAt: now() } : x)),
  });
}

/** Change one measurement with a function (to remove optional fields cleanly). */
export function updateMeasurement(
  id: string,
  fn: (m: SurveyMeasurement) => SurveyMeasurement,
): void {
  const s = get();
  if (s.readOnly) return;
  changed({
    ...s.file,
    measurements: s.file.measurements.map((m) =>
      m.id === id ? { ...fn(m), updatedAt: now() } : m,
    ),
  });
}

/**
 * Put results the app computed on its own (opening a polygon whose stored results are missing or
 * stale) on a measurement. Derived numbers, not a person's edit: `updatedAt` stays, autosave does
 * not run, and the saved baseline takes the same results, so the file does not show unsaved
 * changes. The results are written with the next save (a person's edit, or Recompute).
 */
export function setComputedResults(
  id: string,
  fn: (m: SurveyMeasurement) => SurveyMeasurement['results'],
): void {
  const s = get();
  if (s.readOnly) return;
  const target = s.file.measurements.find((m) => m.id === id);
  if (!target) return;
  setDerived(id, { results: fn(target) });
}

/**
 * Put derived fields on a measurement as `setComputedResults` does: no edit, `updatedAt` stays,
 * the baseline takes them too, and they are written with the next save. Nothing when unchanged.
 * A read-only project (a package) holds a measurement's dates (`series`) in memory, so a client
 * sees its whole volume history as the report prints it; nothing is ever written there.
 */
function setDerived(
  id: string,
  patch: Pick<SurveyMeasurement, 'results'> | Required<Pick<SurveyMeasurement, 'series'>>,
): void {
  const s = get();
  if (s.readOnly && !('series' in patch)) return;
  const target = s.file.measurements.find((m) => m.id === id);
  if (!target) return;
  const same = Object.entries(patch).every(
    ([k, v]) => JSON.stringify(v) === JSON.stringify(target[k]),
  );
  if (same) return;
  const file: MeasurementsFile = {
    ...s.file,
    measurements: s.file.measurements.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  };
  // the same fields on the baseline (when it has the measurement), so only a person's edits
  // count as unsaved; JSON text round trips keep the key order
  const saved = JSON.parse(s.savedText) as { measurements?: { id?: unknown }[] };
  if (Array.isArray(saved.measurements))
    saved.measurements = saved.measurements.map((m) => (m.id === id ? { ...m, ...patch } : m));
  set({
    file,
    savedText: JSON.stringify(saved),
    ...(s.readOnly ? {} : { resultsUnwritten: true }),
  });
}

/** The schema's longest series. */
const SERIES_MAX = 1000;
/** The schema's longest list of replaced results. */
const PREVIOUS_MAX = 20;
/** A series row's date: the `to` capture, or the `from` one for an item that runs from current. */

/**
 * Store results over time (one per item and survey date) on a measurement: each replaces the
 * entry for the same item and date, new dates are added. Derived numbers, not an edit (as
 * `setComputedResults`). Nothing in a read-only project.
 */
export function setSeries(id: string, results: readonly ComparisonResult[]): void {
  const target = get().file.measurements.find((m) => m.id === id);
  if (!target) return;
  const incoming = new Map(results.map((r) => [seriesKeyOf(r), r]));
  const old = target.series ?? [];
  const had = new Set(old.map(seriesKeyOf));
  const series = [
    ...old.map((r) => incoming.get(seriesKeyOf(r)) ?? r),
    ...[...incoming.values()].filter((r) => !had.has(seriesKeyOf(r))),
  ].slice(-SERIES_MAX);
  setDerived(id, { series });
}

/**
 * The measurement with a standard-base result in place of the one for the same item. A carried
 * kit figure it replaces is kept in `previousResults` ("was X m³"), and the carried figures over
 * time are dropped (the engine computes those dates on demand). Pure: `recomputeStandard`
 * (compareStore) runs the engine and stores this as an edit.
 */
export function replaceWithStandard(
  m: SurveyMeasurement,
  result: ComparisonResult,
): SurveyMeasurement {
  const old = m.results.find((r) => r.item === result.item);
  const results = old ? m.results.map((r) => (r === old ? result : r)) : [...m.results, result];
  const next: SurveyMeasurement = { ...m, results };
  if (old?.carried)
    next.previousResults = [
      ...(m.previousResults ?? []),
      {
        netM3: old.netM3,
        totalM3: old.totalM3,
        label: `kit, ${kitBaseLabel(old.carried.base)}`,
        replacedAt: result.computedAt,
      },
    ].slice(-PREVIOUS_MAX);
  if (m.series) {
    const series = m.series.filter((r) => !r.carried);
    if (series.length > 0) next.series = series;
    else delete next.series;
  }
  return next;
}

/**
 * Replace measurements by id as one edit (it waits for Save, or Autosave saves it); ids not in the
 * file are left out. With `undoable` the ones replaced are kept for `undoMeasureChange` and the
 * undo's seq is returned. No-op and null while read-only.
 */
export function replaceMeasurements(
  next: readonly SurveyMeasurement[],
  opts: { undoable?: boolean } = {},
): number | null {
  const s = get();
  if (s.readOnly || next.length === 0) return null;
  const byId = new Map(next.map((m) => [m.id, m]));
  const before = s.file.measurements.filter((m) => byId.has(m.id));
  if (before.length === 0) return null;
  const t = now();
  const file: MeasurementsFile = {
    ...s.file,
    measurements: s.file.measurements.map((m) => {
      const n = byId.get(m.id);
      return n ? { ...n, updatedAt: t } : m;
    }),
  };
  if (!opts.undoable) {
    changed(file);
    return null;
  }
  const seq = ++changeSeq;
  undoAfter = new Map(
    file.measurements.filter((m) => byId.has(m.id)).map((m) => [m.id, asReplaced(m)]),
  );
  changed(file, { undoChange: { seq, before } });
  return seq;
}

/**
 * Put back the measurements of the undoable replacement `seq` as they were before it (by id).
 * True when it did; false (nothing changes) for a stale seq: a later replacement took its place,
 * or one of those measurements was edited, deleted or followed its layer since (the undo is let
 * go then, and the note no longer offers it).
 */
export function undoMeasureChange(seq: number): boolean {
  const s = get();
  const u = s.undoChange;
  if (u?.seq !== seq) return false;
  const note = s.note?.seq === seq ? { note: null } : {};
  if (s.readOnly) {
    set({ undoChange: null, ...note });
    return false;
  }
  const byId = new Map(u.before.map((m) => [m.id, m]));
  changed(
    {
      ...s.file,
      measurements: s.file.measurements.map((m) => byId.get(m.id) ?? m),
    },
    { undoChange: null, ...note },
  );
  return true;
}

/**
 * Show a note about measurements (null clears it). A note with `undo` takes the seq of the
 * undoable replacement it offers to undo, so `undoMeasureChange(note.seq)` undoes it.
 */
export function setMeasureNote(n: Omit<MeasureNote, 'seq'> | null): void {
  if (!n) {
    set({ note: null });
    return;
  }
  const u = get().undoChange;
  const seq = n.undo && u ? u.seq : ++changeSeq;
  set({ note: { ...n, seq } });
}

/** Move measurements into a folder ('' takes them out of any folder). */
export function setFolder(ids: readonly string[], folder: string): void {
  const s = get();
  if (s.readOnly) return;
  const which = new Set(ids);
  const t = now();
  changed({
    ...s.file,
    measurements: s.file.measurements.map((m) => {
      if (!which.has(m.id)) return m;
      const next: SurveyMeasurement = { ...m, updatedAt: t };
      if (folder) next.folder = folder;
      else delete next.folder;
      return next;
    }),
  });
}

export function addMeasurement(m: SurveyMeasurement): void {
  const s = get();
  if (s.readOnly) return;
  changed(
    { ...s.file, measurements: [...s.file.measurements, m] },
    { selected: [m.id], focus: m.id },
  );
}

export function deleteMeasurements(ids: readonly string[]): void {
  const s = get();
  if (s.readOnly) return;
  const gone = new Set(ids);
  const items = s.file.measurements.flatMap((m, index) => (gone.has(m.id) ? [{ m, index }] : []));
  if (items.length === 0) return;
  undoSeq += 1;
  changed(
    { ...s.file, measurements: s.file.measurements.filter((m) => !gone.has(m.id)) },
    {
      selected: s.selected.filter((id) => !gone.has(id)),
      focus: s.focus && gone.has(s.focus) ? null : s.focus,
      editing: s.focus && gone.has(s.focus) ? null : s.editing,
      undoDeletes: [...s.undoDeletes, { items, seq: undoSeq }].slice(-UNDO_DELETES),
    },
  );
}

/**
 * Bring the last deleted measurements back as they were (same ids, folder and style), each at
 * its old place in the file; the deletion before it is offered next. An ordinary edit: it marks
 * the file unsaved, or Autosave saves it.
 */
export function undoDeleteMeasurements(): void {
  const s = get();
  const undoDeletes = s.undoDeletes.slice(0, -1);
  const left = undoLeft(s.undoDeletes.at(-1), s.file);
  if (s.readOnly || !left) {
    set({ undoDeletes: s.readOnly ? [] : undoDeletes });
    return;
  }
  const measurements = [...s.file.measurements];
  for (const { m, index } of [...left.items].sort((a, b) => a.index - b.index))
    measurements.splice(Math.min(index, measurements.length), 0, m);
  const back = left.items.map((x) => x.m.id);
  const focus = back[0] ?? null;
  // the focus moves to what came back: an edit under way on another measurement ends
  changed(
    { ...s.file, measurements },
    { undoDeletes, selected: back, focus, editing: focus === s.focus ? s.editing : null },
  );
}

/** Let go of every deletion's undo (the notice closes). */
export function dismissUndoDelete(): void {
  set({ undoDeletes: [] });
}

/** Copy a measurement into another survey (a new id, scoped to that capture). */
export function copyToSurvey(id: string, capture: string): void {
  const m = get().file.measurements.find((x) => x.id === id);
  if (!m) return;
  const copy: SurveyMeasurement = {
    ...m,
    id: newMeasurementId(),
    scope: { kind: 'survey', capture },
    results: [],
    createdAt: now(),
  };
  delete copy.updatedAt;
  const by = authorName();
  if (by) copy.createdBy = by;
  else delete copy.createdBy;
  // it stays where the original is drawn, whatever shift either date carries
  const manifest = openManifest();
  if (shiftKey(scopeShift(m.scope, manifest)) !== shiftKey(scopeShift(copy.scope, manifest)))
    copy.points = storedPoints(drawnPoints(m, manifest), copy.scope, manifest);
  addMeasurement(copy);
}

export function setScope(id: string, scope: MeasurementScope): void {
  const m = get().file.measurements.find((x) => x.id === id);
  if (!m) return;
  const manifest = openManifest();
  // the shape stays where it is drawn: its points are saved in the new scope's frame
  // two scopes with the same shift share one frame: the points stay as they are
  if (shiftKey(scopeShift(m.scope, manifest)) === shiftKey(scopeShift(scope, manifest))) {
    patchMeasurement(id, { scope });
    return;
  }
  patchMeasurement(id, {
    scope,
    points: storedPoints(drawnPoints(m, manifest), scope, manifest),
    results: m.results.map((r) => ({ ...r, status: 'stale' as const })),
  });
}

// ---------------------------------------------------------------- selection and panels

export function select(ids: string[], focus?: string | null): void {
  const s = get();
  const f = focus === undefined ? (ids.length === 1 ? (ids[0] ?? null) : s.focus) : focus;
  set({ selected: ids, focus: f, editing: f === s.focus ? s.editing : null });
}

export function toggleSelected(id: string): void {
  const s = get();
  select(s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id], id);
}

/**
 * Hide or show saved measurements in the views. View only and remembered per project, so it also
 * works in read-only packages and never counts as an unsaved change.
 */
export function setMeasurementsHidden(ids: readonly string[], hidden: boolean): void {
  const s = get();
  const which = new Set(ids);
  const rest = s.hiddenMeasurements.filter((x) => !which.has(x));
  const next = hidden ? [...rest, ...ids.filter((id) => !s.hiddenMeasurements.includes(id))] : rest;
  set({
    hiddenMeasurements: next,
    ...(hidden && s.focus !== null && which.has(s.focus) ? { editing: null } : {}),
  });
  if (s.projectId) visibilityMemory.save(s.projectId, next);
}

export function setMeasurementHidden(id: string, hidden: boolean): void {
  setMeasurementsHidden([id], hidden);
}

/** Give measurements a preset colour; their fill follows only when it was the old colour. */
export function setMeasurementColour(ids: readonly string[], color: string): void {
  const s = get();
  if (s.readOnly) return;
  const which = new Set(ids);
  const t = now();
  changed({
    ...s.file,
    measurements: s.file.measurements.map((m) => {
      if (!which.has(m.id)) return m;
      const style = m.style
        ? { ...m.style, color, ...(m.style.fill === m.style.color ? { fill: color } : {}) }
        : { color };
      return { ...m, style, updatedAt: t };
    }),
  });
}

/** Rename a measurement; false (and nothing changes) for an empty, over-long or same name. */
export function renameMeasurement(id: string, label: string): boolean {
  const s = get();
  const next = label.trim();
  const m = s.file.measurements.find((x) => x.id === id);
  if (s.readOnly || !m || next === '' || next.length > 200 || next === m.label) return false;
  patchMeasurement(id, { label: next });
  return true;
}

/** The folders in use (trimmed, distinct), A to Z. */
export function measureFolders(file: MeasurementsFile): string[] {
  const folders = new Set<string>();
  for (const m of file.measurements) {
    const f = m.folder?.trim();
    if (f) folders.add(f);
  }
  return [...folders].sort(new Intl.Collator(undefined, { sensitivity: 'base' }).compare);
}

/** Ask the tree to show (open the sidebar for) and select a measurement. */
export function revealMeasurement(id: string | null, opts: { openSidebar?: boolean } = {}): void {
  set({ reveal: { id, seq: ++revealSeq, openSidebar: opts.openSidebar ?? true } });
}

/** Ask the tree for an inline new-folder row that will take these measurements. */
export function askNewFolder(ids: readonly string[]): void {
  revealMeasurement(ids[0] ?? null);
  set({ newFolder: { ids: [...ids], seq: ++newFolderSeq } });
}

export function endNewFolder(): void {
  set({ newFolder: null });
}

export function openDialog(dialog: MeasureDialog): void {
  set({ dialog });
}

export function setAutosave(on: boolean): void {
  set({ autosave: on });
  if (on && isDirty(get())) void saveMeasurements();
}

export function setSnap(patch: Partial<SnapSettings>): void {
  set({ snap: { ...get().snap, ...patch } });
}

export function setSnapSource(source: SnapSource, on: boolean): void {
  const s = get().snap;
  set({ snap: { ...s, sources: { ...s.sources, [source]: on } } });
}

// ---------------------------------------------------------------- drawing

export function startTool(tool: MeasurementTool, opts: StartToolOptions = {}): void {
  const { template = null, forOther } = opts;
  // a read-only project measures without saving, with the tools that can
  const readOnly = get().readOnly;
  if (readOnly && (template || forOther || !READS_WITHOUT_SAVING.has(tool))) return;
  const transient = opts.transient === true || readOnly;
  const projectId = get().projectId;
  const begin = (picks: RolePicks) => {
    if ((get().readOnly && !transient) || get().projectId !== projectId) return;
    drawPicks = [];
    set({
      tool: { tool, template, picks, ...(forOther ?? {}), ...(transient ? { transient } : {}) },
      draw: initialDraw(TOOL_FAMILY[tool]),
      editing: null,
      message: null,
    });
  };
  if (template) void withDesignLayers(template, begin);
  else begin({});
}

/**
 * Run `then` with the site's design layers for a template's roles: at once when the template has
 * none or the site picked them all (and they are still there), otherwise after the person picks
 * them in the prompt (`answerRoles`).
 */
export async function withDesignLayers(
  template: SurveyTemplate,
  then: (picks: RolePicks) => void,
): Promise<void> {
  const projectId = get().projectId;
  if (designRolesOf(template).length === 0 || !projectId) {
    then({});
    return;
  }
  const d = designs.getState();
  if (d.projectId !== projectId || !d.file) await loadDesigns(projectId);
  const list = designs.getState().file?.designs ?? [];
  const { designRoles } = get().settings;
  const picks = validPicks(designRoles, list);
  const roles = missingRoles(template, designRoles, list);
  if (roles.length === 0) {
    then(picks);
    return;
  }
  set({
    rolePrompt: { template, roles, options: designLayerOptions(list), picks, then, error: null },
  });
}

/**
 * The person's answer to the prompt: the layer for each role, kept in the site settings for next
 * time; `null` goes on without the comparisons whose layer is not picked.
 */
export async function answerRoles(
  chosen: Record<string, { design: string; layer: string }> | null,
): Promise<void> {
  const p = get().rolePrompt;
  if (!p) return;
  if (chosen && Object.keys(chosen).length > 0) {
    const settings = get().settings;
    const err = await saveSiteSettings({
      ...settings,
      designRoles: { ...(settings.designRoles ?? {}), ...chosen },
    });
    if (err) {
      set({ rolePrompt: { ...p, error: `The design layers were not saved: ${err}` } });
      return;
    }
  }
  set({ rolePrompt: null });
  p.then({ ...p.picks, ...(chosen ?? {}) });
}

export function cancelRoles(): void {
  set({ rolePrompt: null });
}

export function stopTool(): void {
  drawPicks = [];
  set({ tool: null, draw: null });
}

/** The face winding carries the normal choice through the existing save pipeline. */
export function flipAzimuth(id: string): void {
  const s = get();
  const m = s.file.measurements.find((x) => x.id === id);
  if (m?.tool !== 'azimuth' || s.readOnly) return;
  const flipped = flipFace(m.points);
  patchMeasurement(id, {
    points: flipped,
    ...(m.pickedOn ? { pickedOn: realignPickedOn(m.points, flipped, m.pickedOn) } : {}),
  });
  if (s.focus === id && s.editing) set({ editing: initialEdit(flipFace(s.editing.points)) });
}

/**
 * The live tool's reading, as the island and the live card say it: the primary readout row of
 * the shape drawn so far (to the pointer; `primaryRow`, with the template's items when it has
 * one), or null while it has too few points.
 */
export function liveReading(
  s: Pick<MeasureState, 'tool' | 'draw' | 'settings' | 'surface'>,
): string | null {
  const { tool, draw } = s;
  if (!tool || !draw) return null;
  const pts = draw.cursor && !draw.done ? [...draw.points, draw.cursor] : draw.points;
  if (pts.length < MIN_POINTS[draw.family]) return null;
  const m = measurementFrom(tool.template ?? tool.tool, {
    id: 'live',
    label: '',
    scope: { kind: 'site' },
    points: pts,
    createdAt: '',
  });
  // on each cursor move: the 3D view's terrain only under a point (one raycast). A line's or a
  // polygon's would be thousands, and its primary row is not a terrain row (a berm's crest reads
  // its vertices here; its card reads the terrain once the pointer rests)
  const surface = m.family === 'point' ? (s.surface ?? undefined) : undefined;
  const row = primaryRow(m, { surface }, tool.template?.items);
  // formatted as the tree, the card and the view labels format it (site angles and locale)
  return row ? rowText(row, m, s.settings) : null;
}

function nextLabel(base: string): string {
  const taken = new Set(get().file.measurements.map((m) => m.label));
  for (let n = 1; ; n++) {
    const l = `${base} ${String(n)}`;
    if (!taken.has(l)) return l;
  }
}

/**
 * Takes drawing events before the drawing does (Suggest boundaries, G12: a click asks the model
 * for an outline instead of adding a vertex); returns true when it used the event.
 */
export type DrawInterceptor = (e: DrawEvent, env: DrawEnv) => boolean;
let interceptor: DrawInterceptor | null = null;

export function setDrawInterceptor(f: DrawInterceptor | null): void {
  interceptor = f;
}

/** Feed a drawing event; a finished shape becomes a measurement (unsaved until Save). */
export function drawEvent(e: DrawEvent, env: DrawEnv, pick?: VertexPick): void {
  const s = get();
  if (!s.draw || !s.tool || (s.readOnly && !s.tool.transient)) return;
  // a drawing replaced from outside (Suggest boundaries) leaves the picks the length of its points
  drawPicks = alignPicks(drawPicks, s.draw.points.length, null);
  const telecom = isTelecomTool(s.tool.tool);
  // a finished line measured without saving stays on the canvas until the next click
  if (s.tool.transient && s.draw.done && e.type === 'move') return;
  if (telecom && env.view !== '3d') return;
  if (telecom && e.type === 'key' && !['Escape', 'Backspace'].includes(e.key)) return;
  if (telecom && (e.type === 'finish' || e.type === 'stroke')) return;
  if (!telecom && interceptor?.(e, env)) return;
  // Telecom picks keep their actual height and position, without plan-angle or typed aids.
  const event = telecom && (e.type === 'click' || e.type === 'move') ? { ...e, shift: false } : e;
  let next = drawReducer(s.draw, event, telecom ? {} : env);
  if (
    telecom &&
    isTelecomTool(s.tool.tool) &&
    next.points.length === telecomPointCount(s.tool.tool)
  ) {
    const problem = telecomProblem(s.tool.tool, next.points);
    if (problem) {
      set({ draw: { ...next, points: s.draw.points, cursor: null }, message: problem });
      return;
    }
    next = { ...next, done: true };
  }
  drawPicks = alignPicks(drawPicks, next.points.length, pick ?? null);
  if (next.cancelled) {
    stopTool();
    return;
  }
  if (next.done && s.tool.transient) {
    set({ draw: { ...next, cursor: null }, message: null });
    return;
  }
  if (next.done) {
    const { tool, template, picks } = s.tool;
    // the first vertex's layer says the measurement's date; its points are saved in that date's frame
    const manifest = openManifest();
    const dating = creationDating(drawPicks, {
      index: workspace.getState().dates,
      manifest: manifest ?? { layers: [] },
      focus: timeline.getState().focus,
    });
    const m: SurveyMeasurement = {
      ...measurementFrom(
        template ?? tool,
        {
          id: newMeasurementId(),
          label: nextLabel(template?.name ?? TOOL_LABELS[tool]),
          points: storedPoints(next.points, dating.scope, manifest),
          scope: dating.scope,
          createdAt: now(),
          createdBy: authorName() || undefined,
        },
        picks,
      ),
      ...(dating.source ? { source: dating.source } : {}),
      pickedOn: dating.pickedOn,
    };
    drawPicks = [];
    addMeasurement(m);
    if (telecom) {
      stopTool();
      return;
    }
    if (s.tool.then) {
      // a one-shot drawing for another tool: hand the shape over and stop
      stopTool();
      revealMeasurement(m.id, { openSidebar: false });
      s.tool.then(m);
      return;
    }
    // the tool stays on for the next one (a template used twice in a row)
    set({ draw: initialDraw(TOOL_FAMILY[tool]) });
    revealMeasurement(m.id, { openSidebar: false });
    return;
  }
  set({ draw: next, message: null });
}

// ---------------------------------------------------------------- vertex editing

/** The survey date whose own outline (`outlines`) the edit under way works on, if any. */
let editingDate: string | null = null;

/** The measurement with the outline an edit on `date` works on as its points. */
const asEdited = (m: SurveyMeasurement, date: string | null): SurveyMeasurement => ({
  ...m,
  points: [...editedOutline(m, date)],
});

export function startEditing(): void {
  const s = get();
  const m = s.file.measurements.find((x) => x.id === s.focus);
  if (!m || s.readOnly) return;
  // a pile with an outline per date is edited on the date in focus (volumetric report, bug 1)
  editingDate = timeline.getState().focus;
  // vertices are edited where they are drawn: a survey's own shift added
  set({
    editing: initialEdit(drawnPoints(asEdited(m, editingDate), openManifest())),
    tool: null,
    draw: null,
  });
}

export function stopEditing(): void {
  set({ editing: null });
}

/** Feed a vertex edit; the measurement takes the new points when a drag ends or a value is typed. */
export function editEvent(e: EditEvent): void {
  const s = get();
  const m = s.file.measurements.find((x) => x.id === s.focus);
  if (!s.editing || !m || s.readOnly) return;
  if (isTelecomTool(m.tool) && (e.type === 'delete' || e.type === 'down-mid')) return;
  const next = editReducer(s.editing, e, m.family);
  set({ editing: next });
  if (e.type === 'up' || e.type === 'delete' || e.type === 'set' || e.type === 'escape') {
    const manifest = openManifest();
    const edited = asEdited(m, editingDate);
    const was = drawnPoints(edited, manifest);
    if (JSON.stringify(next.points) !== JSON.stringify(was)) {
      const patch = outlineEdit(m, editingDate, savedEdit(next.points, edited, manifest));
      patchMeasurement(m.id, {
        ...patch,
        // vertices dragged or typed keep their kind; inserted and deleted ones realign it
        ...(patch.points && m.pickedOn && next.points.length !== was.length
          ? { pickedOn: realignPickedOn(was, next.points, m.pickedOn) }
          : {}),
        results: m.results.map((r) => ({ ...r, status: 'stale' as const })),
      });
    }
  }
}

// ---------------------------------------------------------------- templates

/**
 * Every template a measurement can name: the project's, the person's library, then the industry
 * sets the site enables (G9), each id once (the toolbar's order).
 */
export function knownTemplates(s: Pick<MeasureState, 'templates' | 'settings'>): SurveyTemplate[] {
  return templateLibrary(
    s.templates.project,
    s.templates.user,
    industryTemplates(s.settings.templateSets),
  ).map((l) => l.template);
}

export async function saveTemplate(
  scope: 'project' | 'user',
  t: SurveyTemplate,
): Promise<string | null> {
  const s = get();
  const current =
    scope === 'project' ? (s.templates.project ?? emptySurveyTemplates()) : s.templates.user;
  return writeTemplates(scope, upsertTemplate(current, t));
}

export async function deleteTemplate(
  scope: 'project' | 'user',
  id: string,
): Promise<string | null> {
  const s = get();
  const current =
    scope === 'project' ? (s.templates.project ?? emptySurveyTemplates()) : s.templates.user;
  return writeTemplates(scope, removeTemplate(current, id));
}

async function writeTemplates(
  scope: 'project' | 'user',
  file: SurveyTemplatesFile,
): Promise<string | null> {
  const s = get();
  if (scope === 'project' && (!s.projectId || s.readOnly))
    return 'Project templates cannot be changed here.';
  const r = await bridge.call('survey:writeTemplates', {
    scope,
    ...(scope === 'project' && s.projectId ? { projectId: s.projectId } : {}),
    file,
  });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  set({
    templates:
      scope === 'project' ? { ...s.templates, project: file } : { ...s.templates, user: file },
  });
  return null;
}

/** Write the site units (G1's settings channel; refused until it exists). */
export async function saveSiteSettings(settings: SurveySettings): Promise<string | null> {
  const s = get();
  if (!s.projectId) return 'No project is open.';
  const r = await bridge.call('survey:writeSettings', { projectId: s.projectId, settings });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  set({ settings, settingsExist: true });
  return null;
}
