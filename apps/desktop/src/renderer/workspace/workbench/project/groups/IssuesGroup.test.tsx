// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issuesGroup } from './IssuesGroup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const issue = (id: string, code: string, title: string, severity: number, status: string) =>
  ({ id, code, title, severity, status, severityModelId: 'sm' }) as never;

function Probe() {
  const { Body } = issuesGroup;
  return (
    <>
      <span data-testid="count">{issuesGroup.useCount()}</span>
      <Body />
    </>
  );
}
const mount = () => {
  act(() => {
    root.render(<Probe />);
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  workspace.setState({
    project: {
      id: 'p',
      root: '',
      manifest: {
        severityModels: [
          {
            id: 'sm',
            levels: [
              { value: 5, label: 'Critical' },
              { value: 1, label: 'Minor' },
            ],
          },
        ],
      },
    } as never,
    issues: [
      issue('i1', 'F01', 'Cracked slab', 5, 'draft'),
      issue('i2', 'F02', 'Loose bolt', 1, 'approved'),
    ],
    selection: null,
  });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  workspace.setState({ issues: [], selection: null });
});

describe('issuesGroup', () => {
  it('lists issues with severity and status', () => {
    mount();
    expect(host.querySelector('[data-testid="count"]')!.textContent).toBe('2');
    const rows = host.querySelectorAll('[data-testid="project-issue-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('F01 Cracked slab');
    expect(rows[0]!.textContent).toContain('Critical');
    expect(rows[0]!.textContent).toContain('Draft');
    expect(rows[1]!.textContent).toContain('Minor, Approved');
  });

  it('opens the issue card in Selection', () => {
    mount();
    act(() => {
      host.querySelectorAll<HTMLElement>('[data-testid="project-issue-row"]')[1]!.click();
    });
    expect(workspace.getState().selection).toEqual({ kind: 'issue', id: 'i2' });
    act(() => {
      host.querySelector<HTMLElement>('button[aria-label="Open"]')!.click();
    });
    expect(workspace.getState().selection).toEqual({ kind: 'issue', id: 'i1' });
  });

  it('says so when there are none', () => {
    workspace.setState({ issues: [] });
    mount();
    expect(host.textContent).toContain('No issues yet');
  });
});
