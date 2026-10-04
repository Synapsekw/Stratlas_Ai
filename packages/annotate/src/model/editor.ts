import { err, ok, type Issue, type IssueStatus, type Result, type Sighting } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import { History, applyChange, type Change } from './history';
import {
  addSighting,
  createIssue,
  mergeIssues,
  moveSighting,
  newId as randomId,
  STATUS_ORDER,
  findClass,
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
import { compareCodes } from './query';

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

/** Outcome of a bulk action: how many issues changed and which were left alone, and why. */
export interface BulkResult {
  changed: number;
  skipped: { id: string; code: string; error: string }[];
}

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
  /** Bulk: set a status on many issues in one undo step (walking the workflow steps). */
  setStatusMany(ids: readonly string[], status: IssueStatus): BulkResult;
  /** Bulk: set a class on many issues in one undo step; issues whose severity does not fit
   * the class's model are skipped. */
  setClassMany(ids: readonly string[], classId: string): BulkResult;
  /** Bulk: merge duplicates into the most severe (then lowest code) issue, in one undo step. */
  mergeMany(ids: readonly string[]): Result<Issue>;
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
}

export function createIssueEditor(opts: IssueEditorOptions): IssueEditor {
  const { store, saver } = opts;
  const author = opts.author ?? (() => 'user');
  const clock = opts.clock ?? (() => new Date().toISOString());
  const makeId = opts.newId ?? randomId;
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

  /**
   * Write a change into the workspace in one update (bulk edits of thousands of issues stay
   * one render and one save), keeping each issue's place in the list, then queue a save.
   */
  function write(c: Change) {
    const s = store.getState();
    store.setState({ issues: applyChange(s.issues, c) });
    const sel = store.getState().selection;
    if (sel?.kind === 'issue' && c.after[sel.id] === null) s.select(null);
    const pid = store.getState().project?.id;
    if (saver && pid) saver.schedule(pid, store.getState().issues);
  }

  function commit(label: string, after: Record<string, Issue | null>): Result<null> {
    const ctx = context();
    for (const issue of Object.values(after)) {
      if (!issue) continue;
      const v = validateIssue(issue, ctx);
      if (!v.ok) return fail(v.error);
    }
    const before: Record<string, Issue | null> = {};
    for (const id of Object.keys(after)) before[id] = get(id) ?? null;
    // where deleted issues sat, so undo puts them back in place
    const at: Record<string, number> = {};
    const list = store.getState().issues;
    for (const [id, next] of Object.entries(after)) {
      if (next !== null) continue;
      const k = list.findIndex((i) => i.id === id);
      if (k >= 0) at[id] = k;
    }
    const change: Change = { label, before, after, ...(Object.keys(at).length ? { at } : {}) };
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

  const plural = (n: number) => `${n} issue${n === 1 ? '' : 's'}`;

  /** Apply `fn` to each issue, commit every success as one change, report the rest. */
  function bulk(
    ids: readonly string[],
    label: (n: number) => string,
    fn: (i: Issue, now: string) => Result<Issue>,
  ): BulkResult {
    const now = clock();
    const after: Record<string, Issue> = {};
    const skipped: BulkResult['skipped'] = [];
    const ctx = context();
    for (const id of new Set(ids)) {
      const cur = get(id);
      if (!cur) continue;
      const r = fn(cur, now);
      if (!r.ok) {
        skipped.push({ id, code: cur.code, error: r.error });
        continue;
      }
      if (r.value === cur) continue;
      const v = validateIssue(r.value, ctx);
      if (!v.ok) {
        skipped.push({ id, code: cur.code, error: v.error });
        continue;
      }
      after[id] = r.value;
    }
    const changed = Object.keys(after).length;
    if (changed) {
      const c = commit(label(changed), after);
      if (!c.ok) return { changed: 0, skipped };
    }
    return { changed, skipped };
  }

  /** Step through the workflow from the issue's status to `to`. */
  function walkStatus(i: Issue, to: IssueStatus, now: string): Result<Issue> {
    let cur = i;
    const target = STATUS_ORDER.indexOf(to);
    while (cur.status !== to) {
      const at = STATUS_ORDER.indexOf(cur.status);
      const next = STATUS_ORDER[at + (target > at ? 1 : -1)];
      if (!next) return err(`Issue ${i.code} cannot reach ${to}`);
      const r = setStatus(cur, next, now);
      if (!r.ok) return r;
      cur = r.value;
    }
    return ok(cur);
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
      const cur = get(id);
      if (!cur) return fail(`Issue "${id}" does not exist`);
      return commit(`Delete ${cur.code}`, { [id]: null });
    },
    setStatusMany(ids, status) {
      return bulk(
        ids,
        (n) => `Set ${plural(n)} to ${status}`,
        (i, now) => walkStatus(i, status, now),
      );
    },
    setClassMany(ids, classId) {
      const cls = findClass(context(), classId);
      const name = cls?.label ?? classId;
      return bulk(
        ids,
        (n) => `Set ${plural(n)} to ${name}`,
        (i, now) => (i.classId === classId ? ok(i) : updateIssue(i, { classId }, now, context())),
      );
    },
    mergeMany(ids) {
      const issues = [...new Set(ids)].map(get).filter((i): i is Issue => !!i);
      if (issues.length < 2) return fail('Select at least two issues to merge');
      const rankOf = (i: Issue) => (i.severity === 'uncertain' ? -1 : i.severity);
      const [target, ...sources] = [...issues].sort(
        (a, b) => rankOf(b) - rankOf(a) || compareCodes(a.code, b.code),
      );
      if (!target) return fail('Select at least two issues to merge');
      const now = clock();
      const merged = sources.reduce((acc, src) => mergeIssues(acc, src, now), target);
      const sel = store.getState().selection;
      const after: Record<string, Issue | null> = { [target.id]: merged };
      for (const src of sources) after[src.id] = null;
      const c = commit(`Merge ${plural(sources.length)} into ${target.code}`, after);
      if (!c.ok) return err(c.error);
      if (sel?.kind === 'issue' && sources.some((x) => x.id === sel.id))
        store.getState().select({ kind: 'issue', id: target.id });
      return ok(merged);
    },
    undo() {
      const c = history.undo();
      if (!c) return false;
      write(c);
      emit();
      return true;
    },
    redo() {
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
