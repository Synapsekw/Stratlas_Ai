// @vitest-environment jsdom
import type * as Annotate from '@aio/annotate';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueCard } from './IssueCard';
import { isIssueEditing, setIssueEditing } from './state';

vi.mock('@aio/annotate', async (importOriginal) => ({
  ...(await importOriginal<typeof Annotate>()),
  IssueDetail: () => <div data-testid="issue-detail" />,
  useAnnotateReadOnly: () => false,
}));

const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};
const issue = {
  id: 'i1',
  code: 'I-1',
  title: 'Crack',
  status: 'draft',
  severity: 1,
  severityModelId: 'x',
  position: [0, 0, 0],
  evidence: [],
  sightings: [],
  author: 'a',
  updatedAt: '2026-01-01T00:00:00Z',
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  Element.prototype.scrollTo = () => undefined;
  workspace.setState({
    project: { id: 'p', root: '/p', manifest } as never,
    issues: [issue] as never,
  });
  root = createRoot(host);
  act(() => root?.render(<IssueCard issueId="i1" place="issues" />));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.setState({ project: null, issues: [] });
  setIssueEditing(null);
});

const toggle = (open: boolean) => {
  const details = host.querySelector<HTMLDetailsElement>('details.ic-edit');
  if (!details) throw new Error('no edit form');
  act(() => {
    details.open = open;
    details.dispatchEvent(new Event('toggle'));
  });
};

describe('IssueCard reports its edit state', () => {
  it('is editing while the edit form is open and not once it closes', () => {
    expect(isIssueEditing()).toBe(false);
    toggle(true);
    expect(isIssueEditing()).toBe(true);
    toggle(false);
    expect(isIssueEditing()).toBe(false);
  });

  it('stops reporting when the card goes away', () => {
    toggle(true);
    expect(isIssueEditing()).toBe(true);
    act(() => root?.unmount());
    root = undefined;
    expect(isIssueEditing()).toBe(false);
  });
});
