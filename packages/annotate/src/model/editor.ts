import { err, ok, type Issue, type IssueStatus, type Result, type Sighting } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import { History, type Change } from './history';
import {
  addSighting,
  createIssue,
  mergeIssues,
  moveSighting,
  newId as randomId,
  removeSighting,
  replaceSighting,
  setStatus,
  updateIssue,
  validateIssue,
  type IssueContext,
  type IssuePatch,
  type NewIssueInput,
} from './ops';
import type { IssueSaver, SaveState } from './persist';

export interface AuditEntry {
  at: string;
  author: string;
  action: string;
}

export interface EditorState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  save: SaveState;
  /** Last refused change, for a toast. */
  lastError: string | null;
}

export type CreateInput = Omit<NewIssueInput, 'author' | 'now'> & { author?: string };

/**
 * Turns a new image or video sighting into extra sightings, e.g. the back-projected mesh pin
 * (ANN-9). Runs inside the same undo step.
 */
export type DeriveSightings = (sighting: Sighting, issue: Issue) => Sighting[];

export interface IssueEditor {
  readonly state: EditorState;
  context(): IssueContext;
  create(input: CreateInput): Result<Issue>;
  update(id: string, patch: IssuePatch): Result<Issue>;
  setStatus(id: string, status: IssueStatus): Result<Issue>;
  addSighting(id: string, sighting: Sighting): Result<Issue>;
  replaceSighting(id: string, index: number, sighting: Sighting): Result<Issue>;
  removeSighting(id: string, index: number): Result<Issue>;
  moveSighting(fromId: string, index: number, toId: string): Result<Issue>;
  merge(targetId: string, sourceId: string): Result<Issue>;
  remove(id: string): Result<null>;
  undo(): boolean;
  redo(): boolean;
  audit(id: string): readonly AuditEntry[];
  subscribe(listener: () => void): () => void;
}

export interface IssueEditorOptions {
  store: StoreApi<Workspace>;
  saver?: IssueSaver;
  author?: () => string;
  clock?: () => string;
  newId?: () => string;
  derive?: DeriveSightings;
  /** True while the open project is a read-only package: every change is refused, nothing is saved. */
  readOnly?: () => boolean;
}

export const READ_ONLY_ERROR = 'This project is a read-only package. Issues cannot be changed.';

export function createIssueEditor(opts: IssueEditorOptions): IssueEditor {
  const { store, saver } = opts;
  const author = opts.author ?? (() => 'user');
  const clock = opts.clock ?? (() => new Date().toISOString());
  const makeId = opts.newId ?? randomId;
  const readOnly = opts.readOnly ?? (() => false);
  const history = new History();
  const auditLog = new Map<string, AuditEntry[]>();
  const listeners = new Set<() => void>();
  let lastError: string | null = null;
  let state = snapshot();

  function snapshot(): EditorState {
    return {
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
      save: saver?.status ?? { state: 'saved' },
      lastError,
    };
  }

  function emit() {
    state = snapshot();
    for (const l of listeners) l();
  }

  saver?.subscribe(emit);

  let projectId = store.getState().project?.id ?? null;
  store.subscribe((s) => {
    const id = s.project?.id ?? null;
    if (id === projectId) return;
    projectId = id;
    void saver?.flush();
    history.clear();
    auditLog.clear();
    emit();
  });

  const context = (): IssueContext => {
    const m = store.getState().project?.manifest;
    return { models: m?.severityModels ?? [], catalogues: m?.classCatalogues ?? [] };
  };

  const get = (id: string): Issue | undefined => store.getState().issues.find((i) => i.id === id);

  function fail<T>(error: string): Result<T> {
    lastError = error;
    emit();
    return err(error);
  }

  /** Write a change into the workspace through its issue actions, then queue a save. */
  function write(c: Change) {
    const s = store.getState();
    for (const [id, issue] of Object.entries(c.after)) {
      if (issue) s.upsertIssue(issue);
      else s.removeIssue(id);
    }
    const sel = store.getState().selection;
    if (sel?.kind === 'issue' && c.after[sel.id] === null) s.select(null);
    const pid = store.getState().project?.id;
    if (saver && pid) saver.schedule(pid, store.getState().issues);
  }

  function commit(label: string, after: Record<string, Issue | null>): Result<null> {
    if (readOnly()) return fail(READ_ONLY_ERROR);
    const ctx = context();
    for (const issue of Object.values(after)) {
      if (!issue) continue;
      const v = validateIssue(issue, ctx);
      if (!v.ok) return fail(v.error);
    }
    const before: Record<string, Issue | null> = {};
    for (const id of Object.keys(after)) before[id] = get(id) ?? null;
    const change: Change = { label, before, after };
    write(change);
    history.push(change);
    const entry = { at: clock(), author: author(), action: label };
    for (const id of Object.keys(after)) {
      auditLog.set(id, [...(auditLog.get(id) ?? []), entry]);
    }
    lastError = null;
    emit();
    return ok(null);
  }

  function withDerived(issue: Issue, s: Sighting): Issue {
    const extra = opts.derive?.(s, issue) ?? [];
    return extra.reduce((acc, x) => addSighting(acc, x, acc.updatedAt), issue);
  }

  function edit(
    id: string,
    label: (i: Issue) => string,
    fn: (i: Issue, now: string) => Result<Issue>,
  ): Result<Issue> {
    if (readOnly()) return fail(READ_ONLY_ERROR);
    const cur = get(id);
    if (!cur) return fail(`Issue "${id}" does not exist`);
    const r = fn(cur, clock());
    if (!r.ok) return fail(r.error);
    const c = commit(label(cur), { [id]: r.value });
    return c.ok ? r : err(c.error);
  }

  return {
    get state() {
      return state;
    },
    context,
    create(input) {
      if (readOnly()) return fail(READ_ONLY_ERROR);
      const r = createIssue(
        store.getState().issues,
        { ...input, id: input.id ?? makeId(), author: input.author ?? author(), now: clock() },
        context(),
      );
      if (!r.ok) return fail(r.error);
      const issue = withDerived(r.value, input.sighting);
      const c = commit(`Create ${issue.code}`, { [issue.id]: issue });
      return c.ok ? ok(issue) : err(c.error);
    },
    update(id, patch) {
      return edit(
        id,
        (i) => `Edit ${i.code}`,
        (i, now) => updateIssue(i, patch, now, context()),
      );
    },
    setStatus(id, status) {
      return edit(
        id,
        (i) => `${i.code} to ${status}`,
        (i, now) => setStatus(i, status, now),
      );
    },
    addSighting(id, sighting) {
      return edit(
        id,
        (i) => `Add sighting to ${i.code}`,
        (i, now) => ok(withDerived(addSighting(i, sighting, now), sighting)),
      );
    },
    replaceSighting(id, index, sighting) {
      return edit(
        id,
        (i) => `Edit sighting of ${i.code}`,
        (i, now) => replaceSighting(i, index, sighting, now),
      );
    },
    removeSighting(id, index) {
      return edit(
        id,
        (i) => `Remove sighting from ${i.code}`,
        (i, now) => removeSighting(i, index, now),
      );
    },
    moveSighting(fromId, index, toId) {
      if (readOnly()) return fail(READ_ONLY_ERROR);
      const from = get(fromId);
      const to = get(toId);
      if (!from || !to) return fail('Both issues must exist to link a sighting');
      const r = moveSighting(from, index, to, clock());
      if (!r.ok) return fail(r.error);
      const c = commit(`Link sighting to ${to.code}`, {
        [fromId]: r.value.from,
        [toId]: r.value.to,
      });
      return c.ok ? ok(r.value.to) : err(c.error);
    },
    merge(targetId, sourceId) {
      if (readOnly()) return fail(READ_ONLY_ERROR);
      const target = get(targetId);
      const source = get(sourceId);
      if (!target || !source) return fail('Both issues must exist to merge');
      if (targetId === sourceId) return fail('An issue cannot be merged into itself');
      const merged = mergeIssues(target, source, clock());
      const c = commit(`Merge ${source.code} into ${target.code}`, {
        [targetId]: merged,
        [sourceId]: null,
      });
      return c.ok ? ok(merged) : err(c.error);
    },
    remove(id) {
      if (readOnly()) return fail(READ_ONLY_ERROR);
      const cur = get(id);
      if (!cur) return fail(`Issue "${id}" does not exist`);
      return commit(`Delete ${cur.code}`, { [id]: null });
    },
    undo() {
      if (readOnly()) return false;
      const c = history.undo();
      if (!c) return false;
      write(c);
      emit();
      return true;
    },
    redo() {
      if (readOnly()) return false;
      const c = history.redo();
      if (!c) return false;
      write(c);
      emit();
      return true;
    },
    audit(id) {
      return auditLog.get(id) ?? [];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
