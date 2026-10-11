import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { makeIssue } from '../testing';
import { DEFAULT_ISSUE_VIEW, issueView, issuesInView, resetIssueView, setIssueView } from './view';

const manifest = (id: string): ProjectManifest => ({
  schema: 'aio.project/1',
  id,
  name: id,
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
});

const issues = [
  makeIssue({ id: 'a', code: 'F01', severity: 2 }),
  makeIssue({ id: 'b', code: 'F02', severity: 5 }),
  makeIssue({ id: 'c', code: 'F10', severity: 3 }),
  makeIssue({ id: 'd', code: 'F03', severity: 5, status: 'reviewed' }),
];

describe('the issue register view', () => {
  afterEach(() => {
    resetIssueView();
    workspace.getState().closeProject();
  });

  it('starts at the defaults', () => {
    expect(issueView.getState()).toEqual({
      text: '',
      sev: null,
      classId: '',
      status: '',
      dataset: '',
      sort: 'code',
      dir: 'asc',
      groupBy: 'none',
      scope: null,
    });
    expect(DEFAULT_ISSUE_VIEW).toEqual(issueView.getState());
  });

  it('sets part of the view and resets it', () => {
    setIssueView({ sev: 3, text: 'crack' });
    expect(issueView.getState().sev).toBe(3);
    expect(issueView.getState().text).toBe('crack');
    expect(issueView.getState().sort).toBe('code');
    resetIssueView();
    expect(issueView.getState()).toEqual(DEFAULT_ISSUE_VIEW);
  });

  it('shows only the scoped issues, in sort order', () => {
    const v = { ...DEFAULT_ISSUE_VIEW, scope: { label: 'Two', ids: ['c', 'a'] } };
    expect(issuesInView(issues, v).map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('ignores a scoped id that no longer exists', () => {
    const v = { ...DEFAULT_ISSUE_VIEW, scope: { label: 'Gone', ids: ['b', 'zzz'] } };
    expect(issuesInView(issues, v).map((i) => i.id)).toEqual(['b']);
  });

  it('puts the highest severity first when sorting by severity ascending', () => {
    const v = { ...DEFAULT_ISSUE_VIEW, sort: 'severity' as const };
    expect(issuesInView(issues, v).map((i) => i.id)).toEqual(['b', 'd', 'c', 'a']);
    expect(issuesInView(issues, { ...v, dir: 'desc' }).map((i) => i.id)).toEqual([
      'a',
      'c',
      'd',
      'b',
    ]);
  });

  it('applies the filters before sorting, and leaves the text search alone', () => {
    const v = { ...DEFAULT_ISSUE_VIEW, sev: 5 as const, status: 'reviewed' as const, text: 'zzz' };
    expect(issuesInView(issues, v).map((i) => i.id)).toEqual(['d']);
  });

  it('goes back to the defaults when the open project changes', () => {
    workspace.getState().openProject({ id: 'one', root: 'r', manifest: manifest('one') }, []);
    setIssueView({ sev: 2, scope: { label: 'x', ids: ['a'] } });
    workspace.getState().openProject({ id: 'two', root: 'r', manifest: manifest('two') }, []);
    expect(issueView.getState()).toEqual(DEFAULT_ISSUE_VIEW);
  });

  it('keeps the view while the same project stays open', () => {
    workspace.getState().openProject({ id: 'one', root: 'r', manifest: manifest('one') }, []);
    setIssueView({ sev: 2 });
    workspace.getState().replaceManifest(manifest('one'));
    expect(issueView.getState().sev).toBe(2);
  });
});
