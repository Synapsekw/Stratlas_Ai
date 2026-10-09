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
  measurementFrom,
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
import { createStore, useStore } from 'zustand';
import { authorName } from '../author';
import { bridge } from '../shell';
import { designs, loadDesigns } from './designsStore';

export type MeasureDialog =
  | { kind: 'units'; target: 'site' | 'measurement' }
  | { kind: 'templates'; edit: string | null; scope: 'project' | 'user' }
  | null;

export interface ActiveTool {
  tool: MeasurementTool;
  template: SurveyTemplate | null;
  /** The site's design layers for the template's roles (`SurveySettings.designRoles`). */
  picks: RolePicks;
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
  listOpen: boolean;
  dialog: MeasureDialog;
  snap: SnapSettings;
  /** The surface readouts sample (the 3D view's terrain until G2's prepared surfaces). */
  surface: HeightSampler | null;
  /** Asking for the design layers of a template's roles before it is used. */
  rolePrompt: RolePrompt | null;
}

const now = () => new Date().toISOString();
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
  listOpen: false,
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

export const isDirty = (s: Pick<MeasureState, 'file' | 'savedText'>): boolean =>
  text(s.file) !== s.savedText;

// ---------------------------------------------------------------- loading and saving

/** Read the project's measurements, templates and site settings. */
export async function loadMeasurements(projectId: string | null): Promise<void> {
  if (projectId === get().projectId && get().status !== 'error') return;
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
  const patch: Partial<MeasureState> = {
    status: 'ready',
    file: m.value.file,
    savedText: text(m.value.file),
    readOnly: m.value.readOnly,
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
  if (!s.projectId || s.readOnly || s.saving) return false;
  const file = s.file;
  set({ saving: true, message: null });
  const r = await bridge.call('survey:writeMeasurements', { projectId: s.projectId, file });
  const ok = r.ok && r.value.ok;
  const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
  set({
    saving: false,
    message: ok ? 'Measurements saved.' : `Not saved: ${error ?? ''}`,
    ...(ok ? { savedText: text(file) } : {}),
    ...(ok && get().file === file ? { resultsUnwritten: false } : {}),
  });
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
    });
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
  changed(
    { ...s.file, measurements: s.file.measurements.filter((m) => !gone.has(m.id)) },
    {
      selected: s.selected.filter((id) => !gone.has(id)),
      focus: s.focus && gone.has(s.focus) ? null : s.focus,
      editing: s.focus && gone.has(s.focus) ? null : s.editing,
    },
  );
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
  addMeasurement(copy);
}

export function setScope(id: string, scope: MeasurementScope): void {
  patchMeasurement(id, { scope });
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

export function setListOpen(open: boolean): void {
  set({ listOpen: open });
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

export function startTool(tool: MeasurementTool, template: SurveyTemplate | null = null): void {
  if (get().readOnly) return;
  const begin = (picks: RolePicks) => {
    set({
      tool: { tool, template, picks },
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

function nextLabel(base: string): string {
  const taken = new Set(get().file.measurements.map((m) => m.label));
  for (let n = 1; ; n++) {
    const l = `${base} ${String(n)}`;
    if (!taken.has(l)) return l;
  }
}

/** Feed a drawing event; a finished shape becomes a measurement (unsaved until Save). */
export function drawEvent(e: DrawEvent, env: DrawEnv): void {
  const s = get();
  if (!s.draw || !s.tool) return;
  const next = drawReducer(s.draw, e, env);
  if (next.cancelled) {
    stopTool();
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
    // the tool stays on for the next one (a template used twice in a row)
    set({ draw: initialDraw(TOOL_FAMILY[tool]), listOpen: true });
    return;
  }
  set({ draw: next });
}

// ---------------------------------------------------------------- vertex editing

export function startEditing(): void {
  const s = get();
  const m = s.file.measurements.find((x) => x.id === s.focus);
  if (!m || s.readOnly) return;
  set({ editing: initialEdit(m.points), tool: null, draw: null });
}

export function stopEditing(): void {
  set({ editing: null });
}

/** Feed a vertex edit; the measurement takes the new points when a drag ends or a value is typed. */
export function editEvent(e: EditEvent): void {
  const s = get();
  const m = s.file.measurements.find((x) => x.id === s.focus);
  if (!s.editing || !m) return;
  const next = editReducer(s.editing, e, m.family);
  set({ editing: next });
  if (e.type === 'up' || e.type === 'delete' || e.type === 'set' || e.type === 'escape') {
    if (JSON.stringify(next.points) !== JSON.stringify(m.points))
      patchMeasurement(m.id, {
        points: next.points,
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
