import type { Issue, IssueStatus } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Severity } from './ops';
import { filterIssues, sortIssues, type DatasetKind, type IssueSortKey } from './query';
import type { IssueGroupKey } from './register';

/**
 * What the issue register shows: its filters, sort and grouping. They live in a store (not in the
 * component) so something outside the register can set them, such as the agent opening the Issues
 * screen on a few findings. A set chosen that way is `scope`, shown as a chip the person clears.
 */
export interface IssueViewState {
  text: string;
  sev: Severity | null;
  classId: string;
  status: IssueStatus | '';
  dataset: DatasetKind | '';
  sort: IssueSortKey;
  dir: 'asc' | 'desc';
  groupBy: IssueGroupKey;
  /** A set chosen from outside the register (the agent): only these issues, with a chip. */
  scope: { label: string; ids: readonly string[] } | null;
}

export const DEFAULT_ISSUE_VIEW: IssueViewState = {
  text: '',
  sev: null,
  classId: '',
  status: '',
  dataset: '',
  sort: 'code',
  dir: 'asc',
  groupBy: 'none',
  scope: null,
};

export const issueView: StoreApi<IssueViewState> = createStore<IssueViewState>()(() => ({
  ...DEFAULT_ISSUE_VIEW,
}));

export function setIssueView(patch: Partial<IssueViewState>): void {
  issueView.setState(patch);
}

export function resetIssueView(): void {
  issueView.setState({ ...DEFAULT_ISSUE_VIEW });
}

export function useIssueView<T>(selector: (s: IssueViewState) => T): T {
  return useStore(issueView, selector);
}

/**
 * The scope and the filters, in the register's order: only the scoped issues (an id that is gone
 * is ignored), then severity, class, status and dataset. No text search and no sort.
 */
export function filterInView(issues: readonly Issue[], v: IssueViewState): Issue[] {
  const scoped = v.scope ? new Set(v.scope.ids) : null;
  return filterIssues(scoped ? issues.filter((i) => scoped.has(i.id)) : issues, {
    ...(v.sev !== null ? { severities: [v.sev] } : {}),
    ...(v.classId ? { classIds: [v.classId] } : {}),
    ...(v.status ? { statuses: [v.status] } : {}),
    ...(v.dataset ? { datasets: [v.dataset] } : {}),
  });
}

/** The issues the register shows for a view (scope, then filters, then sort), without the text search. */
export function issuesInView(issues: readonly Issue[], v: IssueViewState): Issue[] {
  return sortIssues(filterInView(issues, v), v.sort, v.dir);
}

/**
 * A new project starts with a clean register. Started from the workspace on first use of this
 * module; returns the unsubscribe so a test can stop it.
 */
export function startIssueViewReset(): () => void {
  let last = workspace.getState().project?.id ?? null;
  return workspace.subscribe((s) => {
    const id = s.project?.id ?? null;
    if (id === last) return;
    last = id;
    resetIssueView();
  });
}

startIssueViewReset();
