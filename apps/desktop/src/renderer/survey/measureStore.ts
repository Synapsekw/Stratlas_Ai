/**
 * Survey measurements in the renderer (M11 G3): the project's `survey/measurements.json` and
 * templates, the active tool and its drawing, the selection, vertex editing and the panels. One
 * geometry model for the 3D site view and the 2D map: site points (E, N, Z) in the project CRS.
 * Autosave is off by default (as Propeller does): changes wait for **Save measurements**.
 */
import {
  defaultSurveySettings,
  type DesignPickRef,
  emptyMeasurements,
  emptySurveyTemplates,
  MeasurementsFile,
  type MeasurementScope,
  type MeasurementTool,
  type SitePoint,
  type SurveyMeasurement,
  type SurveySettings,
  type SurveyTemplate,
  type SurveyTemplatesFile,
} from '@aio/schema';
import {
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
  formatRow,
  measurementFrom,
  measurementReadout,
  MIN_POINTS,
  missingRoles,
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
  type RolePicks,
  type SnapSettings,
  type SnapSource,
} from '@aio/survey';
import { shiftKey, workspace } from '@aio/workspace';
import { createStore, useStore } from 'zustand';
import { authorName } from '../author';
import { bridge } from '../shell';
import { designs, loadDesigns } from './designsStore';
import { drawnPoints, scopeShift, storedPoints } from './measureDates';
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
 * Bumped by every load that resets the state: a save that awaited across one (A, then B, then A
 * again) finds it changed and leaves the new load alone, though the project id is the same.
 */
let loadEpoch = 0;
let newFolderSeq = 0;

export const isDirty = (s: Pick<MeasureState, 'file' | 'savedText'>): boolean =>
  text(s.file) !== s.savedText;

// ---------------------------------------------------------------- loading and saving

/** Read the project's measurements, templates and site settings. */
export async function loadMeasurements(projectId: string | null): Promise<void> {
  if (projectId === get().projectId && get().status !== 'error') return;
  loadEpoch += 1;
  set({ ...initial(), projectId, status: projectId ? 'loading' : 'idle' });
  if (!projectId) return;
  const [m, t, s] = await Promise.all([
    bridge.call('survey:readMeasurements', { projectId }),
    bridge.call('survey:readTemplates', { projectId }),
    bridge.call('survey:readSettings', { projectId }),
  ]);
  if (get().projectId !== projectId) return;
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
  const patch: Partial<MeasureState> = {
    status: 'ready',
    file: m.value.file,
    savedText: text(m.value.file),
    readOnly: m.value.readOnly,
    hiddenMeasurements: hidden,
  };
  if (t.ok && t.value.ok) patch.templates = { project: t.value.project, user: t.value.user };
  // site settings are G1's; until they exist the defaults hold (metres)
  if (s.ok && s.value.ok) {
    patch.settings = s.value.settings;
    patch.settingsExist = s.value.exists;
  }
  set(patch);
}

export async function saveMeasurements(): Promise<boolean> {
  const s = get();
  // only a file read in full is written: never the empty one of a load still under way or failed
  if (!s.projectId || s.status !== 'ready' || s.readOnly || s.saving) return false;
  const file = s.file;
  const projectId = s.projectId;
  const epoch = loadEpoch;
  set({ saving: true, message: null });
  const r = await bridge.call('survey:writeMeasurements', { projectId, file });
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

function changed(file: MeasurementsFile, extra: Partial<MeasureState> = {}): void {
  set({ file, message: null, ...extra });
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
  const results = fn(target);
  if (JSON.stringify(results) === JSON.stringify(target.results)) return;
  const file: MeasurementsFile = {
    ...s.file,
    measurements: s.file.measurements.map((m) => (m.id === id ? { ...m, results } : m)),
  };
  // the same results on the baseline (when it has the measurement), so only a person's edits
  // count as unsaved; JSON text round trips keep the key order
  const saved = JSON.parse(s.savedText) as { measurements?: { id?: unknown }[] };
  if (Array.isArray(saved.measurements))
    saved.measurements = saved.measurements.map((m) => (m.id === id ? { ...m, results } : m));
  set({ file, savedText: JSON.stringify(saved), resultsUnwritten: true });
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
  set({ tool: null, draw: null });
}

/** The face winding carries the normal choice through the existing save pipeline. */
export function flipAzimuth(id: string): void {
  const s = get();
  const m = s.file.measurements.find((x) => x.id === id);
  if (m?.tool !== 'azimuth' || s.readOnly) return;
  patchMeasurement(id, { points: flipFace(m.points) });
  if (s.focus === id && s.editing) set({ editing: initialEdit(flipFace(s.editing.points)) });
}

/**
 * The live tool's reading, as the island and the live card say it: the first readout row of the
 * shape drawn so far (to the pointer), or null while it has too few points.
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
  const first = measurementReadout(m, { surface: s.surface ?? undefined })[0];
  return first ? formatRow(first, s.settings.units, s.settings.precision) : null;
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
export function drawEvent(e: DrawEvent, env: DrawEnv): void {
  const s = get();
  if (!s.draw || !s.tool || (s.readOnly && !s.tool.transient)) return;
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
    const m = measurementFrom(
      template ?? tool,
      {
        id: newMeasurementId(),
        label: nextLabel(template?.name ?? TOOL_LABELS[tool]),
        points: next.points,
        scope: { kind: 'site' },
        createdAt: now(),
        createdBy: authorName() || undefined,
      },
      picks,
    );
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

export function startEditing(): void {
  const s = get();
  const m = s.file.measurements.find((x) => x.id === s.focus);
  if (!m || s.readOnly) return;
  // vertices are edited where they are drawn: a survey's own shift added
  set({
    editing: initialEdit(drawnPoints(m, openManifest())),
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
    if (JSON.stringify(next.points) !== JSON.stringify(drawnPoints(m, manifest)))
      patchMeasurement(m.id, {
        points: savedEdit(next.points, m, manifest),
        results: m.results.map((r) => ({ ...r, status: 'stale' as const })),
      });
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
