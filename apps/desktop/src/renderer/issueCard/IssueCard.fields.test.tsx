// @vitest-environment jsdom
/** The issue card lists the custom field values of an issue, read only, with no inputs. */
import type * as Annotate from '@aio/annotate';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueCard } from './IssueCard';
import { clearIssueEditing } from './state';

vi.mock('@aio/annotate', async (importOriginal) => ({
  ...(await importOriginal<typeof Annotate>()),
  IssueDetail: () => <div data-testid="issue-detail" />,
  useAnnotateReadOnly: () => true,
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
const base = {
  id: 'i1',
  code: 'I-1',
  title: 'Gauge',
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
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.setState({ project: null, issues: [] });
  clearIssueEditing();
});

const show = (issue: object) => {
  workspace.setState({
    project: { id: 'p', root: '/p', manifest } as never,
    issues: [issue] as never,
  });
  root = createRoot(host);
  act(() => root?.render(<IssueCard issueId="i1" place="issues" />));
};

describe('IssueCard fields', () => {
  it('lists the issue values without inputs', () => {
    show({
      ...base,
      fields: [
        { key: 'reading', label: 'Reading', type: 'number', value: 42.5, unit: 'bar' },
        { key: 'leaking', label: 'Leaking', type: 'yesno', value: 'yes' },
      ],
    });
    const list = host.querySelector('[data-testid="fields-list"]');
    expect(list?.textContent).toContain('42.5 bar');
    expect(list?.textContent).toContain('Yes');
    expect(list?.querySelector('input, select, button')).toBeNull();
  });

  it('shows no values block for an issue without fields', () => {
    show(base);
    expect(host.querySelector('[data-testid="fields-list"]')).toBeNull();
  });
});
