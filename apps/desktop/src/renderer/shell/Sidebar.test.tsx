// @vitest-environment jsdom
import { ProjectManifest, type RemoveTarget, type WalkLayer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ readOnly: false }));
vi.mock('@aio/annotate', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAnnotateReadOnly: () => h.readOnly,
}));

import { shell } from '../shell';
import { removal } from './removal';
import { Sidebar } from './Sidebar';

const walk = (id: string): WalkLayer => ({
  kind: 'walk',
  id: `walk-${id}`,
  name: `Walk ${id}`,
  visible: true,
  record: { path: `walks/${id}/walk.json` },
  src: { path: `walks/${id}/playback.mp4` },
  durationS: 12,
});
const manifest = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32633 },
  origin: [500000, 4500000, 0],
  captures: [],
  layers: [walk('a'), walk('b'), walk('c')],
  severityModels: [],
  classCatalogues: [],
});

let host: HTMLDivElement;
let root: Root | undefined;
const asked: RemoveTarget[][] = [];
const loadTrash = vi.fn(() => Promise.resolve());

function render(trash: { bytes: number; entries: number } | null) {
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
  removal.setState({
    trash,
    held: 0,
    loadTrash,
    ask: (targets) => {
      asked.push(targets);
      return Promise.resolve();
    },
  });
  act(() => {
    root = createRoot(host);
    root.render(<Sidebar />);
  });
}
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string, init: MouseEventInit = {}) => {
  const el = q(id);
  if (!el) throw new Error(`no ${id}`);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
};
const press = (id: string, key: string) => {
  act(() => {
    q(id)?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  h.readOnly = false;
  asked.length = 0;
  loadTrash.mockClear();
  shell.setState({
    pkg: null,
    settings: { ...shell.getState().settings, sidebarCollapsed: false },
  });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  workspace.getState().closeProject();
  host.remove();
});

describe('Datasets: Delete', () => {
  it('Ctrl+click and Shift+click mark rows; the header deletes them through the dialog', () => {
    render(null);
    expect(q('tree-marked-delete')).toBeNull();
    click('tree-row-walk-a', { ctrlKey: true });
    click('tree-row-walk-c', { shiftKey: true });
    expect(q('tree-marked-delete')?.textContent).toBe('3 selected · Delete…');
    // the add tools step aside while rows are marked
    expect(q('add-data')).toBeNull();
    click('tree-marked-delete');
    expect(asked).toEqual([[{ layer: 'walk-a' }, { layer: 'walk-b' }, { layer: 'walk-c' }]]);
  });

  it('Delete asks for the marked rows, Escape lets them go, a plain click too', () => {
    render(null);
    click('tree-row-walk-b', { ctrlKey: true });
    press('tree-row-walk-b', 'Delete');
    expect(asked).toEqual([[{ layer: 'walk-b' }]]);
    press('tree-row-walk-b', 'Escape');
    expect(q('tree-marked-delete')).toBeNull();
    click('tree-row-walk-a', { ctrlKey: true });
    click('tree-row-walk-b');
    expect(q('tree-marked-delete')).toBeNull();
  });

  it("a walk row's Remove opens the shared dialog", () => {
    render(null);
    click('walk-remove-walk-a');
    expect(asked).toEqual([[{ layer: 'walk-a' }]]);
  });

  it('a reviewer who may only look marks nothing and deletes nothing', () => {
    h.readOnly = true;
    render({ bytes: 2.3 * 1024 ** 3, entries: 2 });
    click('tree-row-walk-a', { ctrlKey: true });
    expect(q('tree-marked-delete')).toBeNull();
    expect(q('walk-remove-walk-a')).toBeNull();
    expect(q('tree-trash')).toBeNull();
  });

  it('the footer shows the trash only when it holds something, and Empty asks first', () => {
    render({ bytes: 0, entries: 0 });
    expect(loadTrash).toHaveBeenCalledWith('p');
    expect(q('tree-trash')).toBeNull();
    act(() => {
      removal.setState({ trash: { bytes: 2.3 * 1024 ** 3, entries: 2 } });
    });
    expect(q('tree-trash')?.textContent).toBe('Trash 2.3 GB·Empty');
    click('tree-trash-empty');
    expect(q('trash-empty')).not.toBeNull();
    click('trash-empty-cancel');
    expect(q('trash-empty')).toBeNull();
  });

  it('a removal that went through lets go of the marks', () => {
    render(null);
    click('tree-row-walk-a', { ctrlKey: true });
    expect(q('tree-marked-delete')).not.toBeNull();
    act(() => {
      removal.setState((s) => ({ removed: s.removed + 1 }));
    });
    expect(q('tree-marked-delete')).toBeNull();
  });

  it('says so when Empty could not delete every removal', () => {
    render(null);
    act(() => {
      removal.setState({ held: 2 });
    });
    expect(document.body.textContent).toContain(
      '2 removals could not be deleted yet: something still uses them. Try again later.',
    );
  });
});
