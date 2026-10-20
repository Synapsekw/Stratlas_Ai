/**
 * The report template of the open project (volumetric parity W8): which measurement figures go
 * into the report, kept by main in `report/template.json` (`report:readTemplate` and
 * `report:writeTemplate`). "Add to report" appends to it.
 *
 * An add reads the file afresh first and refuses when main cannot read it (unreadable, invalid,
 * saved by a newer build): a template is never written over without what is in it. Adds run one
 * at a time, so two quick adds do not lose one another.
 */
import type { ReportTemplateFile, TemplateEntry } from '@aio/schema';
import { emptyReportTemplate } from '@aio/schema';
import { t } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge } from '../shell';
import { measureStore } from '../survey/measureStore';
import { measurementHasChart } from '../survey/card/chartRule';

/** The most entries a template holds (`ReportTemplateFile.entries`, max 500). */
export const TEMPLATE_MAX = 500;

export type TemplateParts = Extract<TemplateEntry, { kind: 'measurement' }>['parts'];

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

/**
 * Add measurements to the end of the template in the order given (the caller passes the sidebar
 * tree order); the ones in it already are left where they are. Nothing new, nothing written.
 * Throws the sentence main gave when the template cannot be read or saved.
 */
export function addManyToReport(
  ids: readonly string[],
  parts?: TemplateParts,
): Promise<{ added: string[]; already: string[] }> {
  const run = queue.then(async () => {
    const projectId = openProject();
    const file = (await read(projectId)) ?? emptyReportTemplate();
    const there = new Set(file.entries.flatMap((e) => (e.kind === 'measurement' ? [e.id] : [])));
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
    if (added.length > 0) {
      const next: ReportTemplateFile = { ...file, entries };
      const r = await bridge.call('report:writeTemplate', { projectId, file: next });
      if (!r.ok) throw new Error(r.error);
      if (!r.value.ok) throw new Error(r.value.error);
      templateStore.setState({ projectId, file: next, error: null });
    } else {
      templateStore.setState({ projectId, file, error: null });
    }
    return { added, already };
  });
  // a refused add does not stop the next one
  queue = run.catch(() => undefined);
  return run;
}

/** Add one measurement to the report: `'already'` when it is in the template. */
export async function addToReport(id: string, parts?: TemplateParts): Promise<'added' | 'already'> {
  const r = await addManyToReport([id], parts);
  return r.added.length > 0 ? 'added' : 'already';
}
