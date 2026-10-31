// @vitest-environment jsdom
import type { Issue, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../placement', () => ({ offerPlacement: vi.fn() }));
// Move point on a cloud-point finding shows only while the inspector UI is on
vi.mock('./flag', () => ({ isInspectorUiOn: () => true }));

const { IssueMenuMount } = await import('./IssueMenuMount');
const { closeIssueMenu, issueMenu, openIssueMenu } = await import('./issueMenuStore');

const manifest = {
  captures: [],
  layers: [],
  crs: { kind: 'local' },
  origin: { e: 0, n: 0, z: 0 },
} as unknown as ProjectManifest;
const issue = {
  id: 'i1',
  code: 'F01',
  classId: 'c',
  severityModelId: 'm',
  severity: 1,
  status: 'draft',
  title: 't',
  note: '',
  author: 'a',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  source: 'import',
  sightings: [{ on: 'pointcloud', layer: 'l', geom: { type: 'point3', p: [0, 0, 0] } }],
} as unknown as Issue;

let root: Root | undefined;
let host: HTMLElement;
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest }, [issue]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<IssueMenuMount />);
  });
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host.remove();
  closeIssueMenu();
});

describe('IssueMenuMount', () => {
  it('shows nothing until a register row is right-clicked', () => {
    expect(issueMenu.getState().at).toBeNull();
    expect(q('issue-menu')).toBeNull();
  });

  it('a right-click on a row shows Place on model and Move point', () => {
    act(() => {
      openIssueMenu({ x: 10, y: 20, ids: ['i1'], clicked: 'i1' });
    });
    expect(q('issue-menu')).not.toBeNull();
    expect(q('issue-place-on-model')).not.toBeNull();
    expect(q('finding-move-point')).not.toBeNull();
  });

  it('closing the menu clears it', () => {
    act(() => {
      openIssueMenu({ x: 0, y: 0, ids: ['i1'], clicked: 'i1' });
    });
    act(() => {
      closeIssueMenu();
    });
    expect(q('issue-menu')).toBeNull();
  });
});
