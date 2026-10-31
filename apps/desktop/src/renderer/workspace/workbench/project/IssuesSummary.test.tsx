// @vitest-environment jsdom
import type { Issue } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shell } from '../../../shell';
import { threeDates } from '../../__fixtures__/threeDates';
import { workbench } from '../workbenchStore';
import { IssuesSummary, summariseIssues } from './IssuesSummary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const issue = (
  id: string,
  severity: Issue['severity'],
  status: Issue['status'] = 'reviewed',
  updatedAt = '2026-10-01T00:00:00.000Z',
): Issue => ({
  id,
  code: `F${id.padStart(2, '0')}`,
  classId: 'c',
  severityModelId: 's',
  severity,
  status,
  title: `Issue ${id}`,
  note: '',
  author: 'a',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt,
  sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } }],
  source: 'human',
});

describe('summariseIssues', () => {
  it('five most severe open issues, counts by severity', () => {
    const issues = [
      issue('1', 1),
      issue('2', 'uncertain'),
      issue('3', 3),
      issue('4', 2),
      issue('5', 3, 'draft', '2026-10-05T00:00:00.000Z'),
      issue('6', 1),
      issue('7', 4, 'closed'),
      issue('8', 2),
    ];
    const s = summariseIssues(issues);
    expect(s.open).toBe(7);
    // closed issues are left out; uncertain ranks below every graded severity
    expect(s.counts).toEqual([
      { severity: 3, count: 2 },
      { severity: 2, count: 2 },
      { severity: 1, count: 2 },
      { severity: 'uncertain', count: 1 },
    ]);
    // most severe first, the newest first on a tie
    expect(s.top.map((i) => i.id)).toEqual(['5', '3', '4', '8', '1']);
  });

  it('puts an uncertain issue last, and has nothing for a project with no open issue', () => {
    expect(summariseIssues([issue('1', 'uncertain'), issue('2', 1)]).top.map((i) => i.id)).toEqual([
      '2',
      '1',
    ]);
    expect(summariseIssues([issue('1', 3, 'closed')])).toEqual({ counts: [], top: [], open: 0 });
  });
});

describe('IssuesSummary', () => {
  let host: HTMLDivElement;
  let root: Root | undefined;
  const render = () => {
    root ??= createRoot(host);
    act(() => {
      root?.render(<IssuesSummary />);
    });
  };

  beforeEach(() => {
    workspace.getState().openProject({ id: 'p1', root: '/p1', manifest: threeDates });
    workspace.setState({ issues: [issue('1', 2), issue('2', 4), issue('3', 1, 'closed')] });
    workbench.getState().show('project');
    host = document.createElement('div');
    document.body.append(host);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    workspace.getState().closeProject();
  });

  it('lists the open issues, and a row click selects the issue and brings the Selection tab', () => {
    render();
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.wb-issues-row')];
    expect(rows.map((r) => r.textContent)).toEqual(['S4F02Issue 2', 'S2F01Issue 1']);
    expect(workbench.getState().panel).toBe('project');
    act(() => {
      rows[0]?.click();
    });
    expect(workspace.getState().selection).toEqual({ kind: 'issue', id: '2' });
    expect(workbench.getState().panel).toBe('selection');
  });

  it('says so when no issue is open, and goes to the Issues screen from Open in Issues', () => {
    workspace.setState({ issues: [issue('3', 1, 'closed')] });
    render();
    expect(host.textContent).toContain('No open issues.');
    const open = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Open in Issues',
    );
    act(() => {
      open?.click();
    });
    expect(shell.getState().screen).toBe('issues');
    act(() => {
      shell.getState().go('scene');
    });
  });
});
