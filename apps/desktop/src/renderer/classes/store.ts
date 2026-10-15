/**
 * Class editing for the open project (ANN-7): create (also from pickers, detections and the
 * assistant), edit, delete-and-move, undo, and the class library on this computer. Every catalogue
 * change is one `builder:updateClasses` write; when it fails the manifest stays as it was and the
 * notice says why. Undo restores the catalogues and, for a delete that moved issues, undoes the
 * issue editor's move command of the same label.
 */
import {
  addClass,
  isAnnotateReadOnly,
  issueEditor,
  issueSaver,
  removeClass,
  updateClass,
  type ClassPatch,
  type NewClass,
} from '@aio/annotate';
import type { ClassCatalogue, IssueClass, LibraryClass } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { dispatch, loadDetections } from '../detections/store';
import { bridge, shell } from '../shell';

export interface ClassEdit {
  label: string;
  before: ClassCatalogue[];
  after: ClassCatalogue[];
  /** The issue editor command that moved the deleted class's issues (undone with it). */
  issueCommand?: string;
}

export interface ClassNoticeState {
  text: string;
  undo: boolean;
  error: boolean;
  at: number;
}

interface ClassesState {
  projectId: string | null;
  past: ClassEdit[];
  future: ClassEdit[];
  notice: ClassNoticeState | null;
}

const LIMIT = 50;

export const classes = createStore<ClassesState>()(() => ({
  projectId: null,
  past: [],
  future: [],
  notice: null,
}));

export function useClasses<T>(selector: (s: ClassesState) => T): T {
  return useStore(classes, selector);
}

workspace.subscribe((s, prev) => {
  const id = s.project?.id ?? null;
  if (id === (prev.project?.id ?? null)) return;
  classes.setState({ projectId: id, past: [], future: [], notice: null });
});

/** Why classes cannot be changed now, or null. */
export function readOnlyReason(): string | null {
  if (!workspace.getState().project) return t('classes.noProject');
  if (shell.getState().pkg || isAnnotateReadOnly()) return t('classes.readOnly');
  return null;
}

function notify(text: string, opts: { undo?: boolean; error?: boolean } = {}): void {
  classes.setState({
    notice: { text, undo: opts.undo ?? false, error: opts.error ?? false, at: Date.now() },
  });
}

export function dismissNotice(): void {
  classes.setState({ notice: null });
}

const catalogues = () => workspace.getState().project?.manifest.classCatalogues ?? [];
const models = () => workspace.getState().project?.manifest.severityModels ?? [];

/** Save the catalogues; null when saved, else why not (the manifest is then unchanged). */
async function write(next: ClassCatalogue[]): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return t('classes.noProject');
  const r = await bridge.call('builder:updateClasses', { projectId: project.id, catalogues: next });
  const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
  if (error !== null) {
    notify(t('classes.notSaved', { error }), { error: true });
    return error;
  }
  if (r.ok && r.value.ok && workspace.getState().project?.id === project.id) {
    workspace.getState().replaceManifest(r.value.manifest);
  }
  return null;
}

function push(edit: ClassEdit): void {
  classes.setState((s) => ({ past: [...s.past, edit].slice(-LIMIT), future: [] }));
}

/** A class from a name (and, from the library, a colour and hotkey). Throws with the sentence. */
export async function createClass(
  label: string,
  extra: Omit<NewClass, 'label'> = {},
): Promise<IssueClass> {
  const reason = readOnlyReason();
  if (reason) throw new Error(reason);
  const before = catalogues();
  const r = addClass(before, models(), { ...extra, label });
  if (!r.ok) throw new Error(r.error);
  if (!r.value.created) return r.value.cls;
  const e = await write(r.value.catalogues);
  if (e) throw new Error(t('classes.notSaved', { error: e }));
  push({ label: `Create class ${r.value.cls.label}`, before, after: r.value.catalogues });
  notify(t('classes.created', { label: r.value.cls.label }), { undo: true });
  return r.value.cls;
}

export async function editClass(id: string, patch: ClassPatch): Promise<string | null> {
  const reason = readOnlyReason();
  if (reason) return reason;
  const before = catalogues();
  const r = updateClass(before, models(), id, patch);
  if (!r.ok) return r.error;
  const e = await write(r.value.catalogues);
  if (e) return e;
  push({ label: `Edit class ${r.value.cls.label}`, before, after: r.value.catalogues });
  return null;
}

/** Waiting and rejected detections of class `from` go to `to` (loads the review if needed). */
async function moveDetections(projectId: string, from: string, to: string): Promise<void> {
  // severities map onto the severity model of the class they move to
  const target = catalogues()
    .flatMap((c) => c.classes)
    .find((c) => c.id === to);
  const model = models().find((m) => m.id === target?.severityModel);
  if (!model) return;
  await loadDetections(projectId);
  dispatch({ type: 'reclass', from, to, model, now: new Date().toISOString() });
}

/**
 * Delete a class. A class issues use needs `moveTo`: its issues move there (one issue editor
 * command, severities mapped) and its detections too, then the catalogue is written.
 */
export async function deleteClass(id: string, moveTo: string | null): Promise<string | null> {
  const reason = readOnlyReason();
  if (reason) return reason;
  const project = workspace.getState().project;
  if (!project) return t('classes.noProject');
  const before = catalogues();
  const cls = before.flatMap((c) => c.classes).find((c) => c.id === id);
  if (!cls) return `Class "${id}" is not in the project.`;
  const removed = removeClass(before, id);
  if (!removed.ok) return removed.error;
  const used = workspace.getState().issues.some((i) => i.classId === id);
  if (used && (!moveTo || moveTo === id)) return t('classes.delete.pickTarget');
  let issueCommand: string | undefined;
  if (used && moveTo) {
    const moved = issueEditor.reassignClass(id, moveTo);
    if (moved.skipped.length > 0) {
      if (moved.changed > 0) issueEditor.undo();
      return moved.skipped[0]?.error ?? t('classes.delete.pickTarget');
    }
    issueCommand = issueEditor.state.undoLabel ?? undefined;
  }
  if (moveTo && moveTo !== id) await moveDetections(project.id, id, moveTo);
  // main checks issues.json: the moved issues must be on disk before the class goes
  await issueSaver.flush();
  const e = await write(removed.value);
  if (e) {
    if (issueCommand && issueEditor.state.undoLabel === issueCommand) issueEditor.undo();
    return e;
  }
  push({
    label: `Delete class ${cls.label}`,
    before,
    after: removed.value,
    ...(issueCommand ? { issueCommand } : {}),
  });
  notify(t('classes.deleted', { label: cls.label }), { undo: true });
  return null;
}

export async function undoClassEdit(): Promise<boolean> {
  const edit = classes.getState().past.at(-1);
  if (!edit || readOnlyReason()) return false;
  // the class comes back first, then its issues
  if (await write(edit.before)) return false;
  if (edit.issueCommand && issueEditor.state.undoLabel === edit.issueCommand) issueEditor.undo();
  classes.setState((s) => ({
    past: s.past.slice(0, -1),
    future: [...s.future, edit],
    notice: null,
  }));
  return true;
}

export async function redoClassEdit(): Promise<boolean> {
  const edit = classes.getState().future.at(-1);
  if (!edit || readOnlyReason()) return false;
  // issues move away first, then the class goes
  const movedIssues = !!edit.issueCommand && issueEditor.state.redoLabel === edit.issueCommand;
  if (movedIssues) {
    issueEditor.redo();
    await issueSaver.flush();
  }
  if (await write(edit.after)) {
    if (movedIssues) issueEditor.undo();
    return false;
  }
  classes.setState((s) => ({
    future: s.future.slice(0, -1),
    past: [...s.past, edit],
    notice: null,
  }));
  return true;
}

// ---- class library (this computer) ----

export async function listLibrary(): Promise<LibraryClass[]> {
  const r = await bridge.call('classLibrary:list', {});
  return r.ok ? r.value : [];
}

export async function saveToLibrary(cls: IssueClass): Promise<string | null> {
  const model = models().find((m) => m.id === cls.severityModel);
  const r = await bridge.call('classLibrary:save', {
    cls: {
      label: cls.label,
      color: cls.color,
      ...(cls.hotkey ? { hotkey: cls.hotkey } : {}),
      ...(model ? { severityLevels: model.levels.map((l) => l.label) } : {}),
    },
  });
  const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
  if (error !== null) return error;
  notify(t('classes.savedToLibrary', { label: cls.label }));
  return null;
}

export async function removeFromLibrary(label: string): Promise<string | null> {
  const r = await bridge.call('classLibrary:remove', { label });
  return !r.ok ? r.error : r.value.ok ? null : r.value.error;
}

/** Add library classes to the open project in one write (new-project wizard). */
export async function addLibraryClasses(entries: readonly LibraryClass[]): Promise<string | null> {
  if (entries.length === 0) return null;
  let next = catalogues();
  for (const e of entries) {
    const r = addClass(next, models(), {
      label: e.label,
      color: e.color,
      ...(e.hotkey ? { hotkey: e.hotkey } : {}),
    });
    if (!r.ok) return r.error;
    next = r.value.catalogues;
  }
  return write(next);
}
