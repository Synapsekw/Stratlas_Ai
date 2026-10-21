/**
 * The report template of the open project (volumetric parity W8): which measurement figures go
 * into the report, kept by main in `report/template.json` (`report:readTemplate` and
 * `report:writeTemplate`). "Add to report" appends to it, "Remove from report" takes measurements
 * out and "Clear report template" empties it (the report then lists every measurement again).
 *
 * The report reads the measurements file on disk, so an add saves unsaved measurements first, or
 * refuses ("Save the measurements first") when it cannot. An add also drops the entries of
 * measurements deleted since, and keeps entries a later build added.
 *
 * An add reads the file afresh first and refuses when main cannot read it (unreadable, invalid,
 * saved by a newer build): a template is never written over without what is in it. Adds run one
 * at a time, so two quick adds do not lose one another.
 */
import type { ReportTemplateFile, TemplatePart } from '@aio/schema';
import { emptyReportTemplate, isMeasurementEntry } from '@aio/schema';
import { t } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge } from '../shell';
import { isDirty, measureStore, saveMeasurements } from '../survey/measureStore';
import { measurementHasChart } from '../survey/card/chartRule';

/** The most entries a template holds (`ReportTemplateFile.entries`, max 500). */
export const TEMPLATE_MAX = 500;

export type TemplateParts = TemplatePart[];

interface TemplateState {
  /** The project the template was read for. */
  projectId: string | null;
  file: ReportTemplateFile | null;
  /** Why the template could not be read. */
  error: string | null;
}

export const templateStore = createStore<TemplateState>()(() => ({
  projectId: null,
  file: null,
  error: null,
}));

function openProject(): string {
  const id = workspace.getState().project?.id;
  if (!id) throw new Error(t('report.noProject'));
  return id;
}

async function read(projectId: string): Promise<ReportTemplateFile | null> {
  const r = await bridge.call('report:readTemplate', { projectId });
  if (!r.ok) throw new Error(r.error);
  if (!r.value.ok) throw new Error(r.value.error);
  return r.value.file;
}

/** Read the open project's template into the store (null file: none yet). */
export async function loadTemplate(): Promise<void> {
  const projectId = workspace.getState().project?.id ?? null;
  if (!projectId) {
    templateStore.setState({ projectId: null, file: null, error: null });
    return;
  }
  try {
    const file = await read(projectId);
    templateStore.setState({ projectId, file, error: null });
  } catch (e) {
    templateStore.setState({ projectId, file: null, error: (e as Error).message });
  }
}

/** The open project's template, read when the project changes; null when it has none. */
export function useTemplate(): ReportTemplateFile | null {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const loadedFor = useStore(templateStore, (s) => s.projectId);
  const file = useStore(templateStore, (s) => s.file);
  useEffect(() => {
    if (projectId !== loadedFor) void loadTemplate();
  }, [projectId, loadedFor]);
  return projectId === loadedFor ? file : null;
}

/** The parts a measurement goes in with: its value, and its chart when its tool draws one. */
export function defaultParts(id: string): TemplateParts {
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  return m && measurementHasChart(m) ? ['value', 'chart'] : ['value'];
}

let queue: Promise<unknown> = Promise.resolve();

/** Run one change of the template after the ones before it (a refused one does not stop the next). */
function queued<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job);
  queue = run.catch(() => undefined);
  return run;
}

/** The measure store, when it holds this project's measurements. */
function loadedFor(projectId: string) {
  const s = measureStore.getState();
  return s.projectId === projectId && s.status === 'ready' ? s : null;
}

/**
 * The report prints the measurements file on disk: unsaved measurements (new ones, edits, figures
 * worked out since the last save) are saved first. Throws "Save the measurements first" when the
 * save cannot be made.
 */
async function savedFirst(projectId: string): Promise<void> {
  const s = loadedFor(projectId);
  if (!s || (!isDirty(s) && !s.resultsUnwritten)) return;
  if (s.readOnly || !(await saveMeasurements())) throw new Error(t('report.saveFirst'));
}

/** Write the template, and hold it in the store. */
async function write(projectId: string, next: ReportTemplateFile): Promise<void> {
  const r = await bridge.call('report:writeTemplate', { projectId, file: next });
  if (!r.ok) throw new Error(r.error);
  if (!r.value.ok) throw new Error(r.value.error);
  templateStore.setState({ projectId, file: next, error: null });
}

/**
 * Add measurements to the end of the template in the order given (the caller passes the sidebar
 * tree order); the ones in it already are left where they are. Nothing new, nothing written.
 * Throws the sentence main gave when the template cannot be read or saved.
 */
export function addManyToReport(
  ids: readonly string[],
  parts?: TemplateParts,
): Promise<{ added: string[]; already: string[] }> {
  return queued(async () => {
    const projectId = openProject();
    await savedFirst(projectId);
    const read0 = (await read(projectId)) ?? emptyReportTemplate();
    // the entries of measurements deleted since are dropped (they count toward the limit)
    const store = loadedFor(projectId);
    const present = store ? new Set(store.file.measurements.map((m) => m.id)) : null;
    const pruned = present
      ? read0.entries.filter((e) => !isMeasurementEntry(e) || present.has(e.id))
      : read0.entries;
    const file = { ...read0, entries: pruned };
    const there = new Set(file.entries.flatMap((e) => (isMeasurementEntry(e) ? [e.id] : [])));
    const added: string[] = [];
    const already: string[] = [];
    const addedAt = new Date().toISOString();
    const entries = [...file.entries];
    for (const id of ids) {
      if (there.has(id)) {
        already.push(id);
        continue;
      }
      there.add(id);
      added.push(id);
      entries.push({ kind: 'measurement', id, parts: [...(parts ?? defaultParts(id))], addedAt });
    }
    if (added.length > 0 && entries.length > TEMPLATE_MAX)
      throw new Error(t('report.full', { count: TEMPLATE_MAX }));
    if (added.length > 0) await write(projectId, { ...file, entries });
    else templateStore.setState({ projectId, file: read0, error: null });
    return { added, already };
  });
}

/**
 * Take measurements out of the template ("Remove from report"); the others stay in their order.
 * Nothing of them there, nothing written. Throws the sentence main gave when it cannot.
 */
export function removeFromReport(ids: readonly string[]): Promise<{ removed: string[] }> {
  return queued(async () => {
    const projectId = openProject();
    const file = await read(projectId);
    const out = new Set(ids);
    const removed = (file?.entries ?? []).flatMap((e) =>
      isMeasurementEntry(e) && out.has(e.id) ? [e.id] : [],
    );
    if (!file || removed.length === 0) {
      templateStore.setState({ projectId, file, error: null });
      return { removed: [] };
    }
    const entries = file.entries.filter((e) => !isMeasurementEntry(e) || !out.has(e.id));
    await write(projectId, { ...file, entries });
    return { removed };
  });
}

/** Empty the template ("Clear report template"): the report lists every measurement again. */
export function clearReportTemplate(): Promise<void> {
  return queued(async () => {
    const projectId = openProject();
    const file = await read(projectId);
    if (!file || file.entries.length === 0) {
      templateStore.setState({ projectId, file, error: null });
      return;
    }
    await write(projectId, { ...file, entries: [] });
  });
}

/**
 * Whether the template, as last read, holds one of the measurements (Remove from report is offered
 * then); null when it was not read for the open project yet, which starts the read.
 */
export function reportHolds(ids: readonly string[]): boolean | null {
  const s = templateStore.getState();
  const projectId = workspace.getState().project?.id ?? null;
  if (!projectId) return false;
  if (s.projectId !== projectId) {
    void loadTemplate();
    return null;
  }
  const want = new Set(ids);
  return (s.file?.entries ?? []).some((e) => isMeasurementEntry(e) && want.has(e.id));
}

/** Add one measurement to the report: `'already'` when it is in the template. */
export async function addToReport(id: string, parts?: TemplateParts): Promise<'added' | 'already'> {
  const r = await addManyToReport([id], parts);
  return r.added.length > 0 ? 'added' : 'already';
}
