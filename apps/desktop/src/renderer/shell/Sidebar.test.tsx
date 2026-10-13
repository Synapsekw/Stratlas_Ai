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
const project = (captures: unknown[], layers: unknown[]) =>
  ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32633 },
    origin: [500000, 4500000, 0],
    captures,
    layers,
    severityModels: [],
    classCatalogues: [],
  });
const manifest = project([], [walk('a'), walk('b'), walk('c')]);
// a basemap and a retired viewer are never deleted from the tree
const basemap = { kind: 'basemap', id: 'bm', name: 'Street map', pack: 'osm', style: 'dark' };
const legacy = {
  kind: 'legacy',
  id: 'lg',
  name: 'Old viewer',
  viewer: 'aik',
  entry: { path: 'legacy/index.html' },
};
const withKept = project([], [walk('a'), walk('b'), walk('c'), basemap, legacy]);
// survey dates on: walk a under 12 Oct, walk b under Every date
const dated = project(
  [{ id: 'c1', label: 'Survey', date: '2026-10-12' }],
  [{ ...walk('a'), capture: 'c1' }, walk('b')],
);

let host: HTMLDivElement;
let root: Root | undefined;
const asked: RemoveTarget[][] = [];
const loadTrash = vi.fn(() => Promise.resolve());

function render(trash: { bytes: number; entries: number } | null, m: ProjectManifest = manifest) {
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest: m });
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
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    q(id)?.dispatchEvent(e);
  });
  return e;
};
const rightClick = (id: string) => {
  const el = q(id);
  if (!el) throw new Error(`no ${id}`);
  act(() => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    );
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

  it('says so each time Empty could not delete every removal', () => {
    const text = '2 removals could not be deleted yet: something still uses them. Try again later.';
    render({ bytes: 1024, entries: 2 });
    act(() => {
      removal.setState({ held: 2 });
    });
    expect(q('date-note')?.textContent).toContain(text);
    const dismiss = q('date-note')?.querySelector('button');
    act(() => dismiss?.click());
    expect(q('date-note')).toBeNull();
    // the second Empty leaves the same two removals held: the note comes back
    click('tree-trash-empty');
    click('trash-empty-cancel');
    act(() => {
      removal.setState({ held: 2 });
    });
    expect(q('date-note')?.textContent).toContain(text);
  });
});

describe('Datasets: Delete in the menus', () => {
  it('Delete and Escape typed in a date name field are the field’s, not the marks’', () => {
    render(null, dated);
    click('tree-row-walk-b', { ctrlKey: true });
    expect(q('tree-marked-delete')).not.toBeNull();
    press('date-name-c1', 'F2');
    expect(q('date-rename')).not.toBeNull();
    const del = press('date-rename', 'Delete');
    expect(del.defaultPrevented).toBe(false);
    expect(asked).toEqual([]);
    press('date-rename', 'Escape');
    expect(q('tree-marked-delete')).not.toBeNull();
  });

  it("a date folder's Delete… asks for the date", () => {
    render(null, dated);
    click('date-more-c1');
    click('date-menu-delete');
    expect(asked).toEqual([[{ capture: 'c1' }]]);
  });

  it("a group header's Delete… asks for its layers, survey dates on", () => {
    render(null, dated);
    rightClick('tree-group-walks');
    click('menu-delete');
    expect(asked).toEqual([[{ layer: 'walk-b' }]]);
  });

  it("a group header's Delete… asks for its layers, survey dates off", () => {
    render(null);
    rightClick('tree-group-walks');
    expect(q('move-to-every')).toBeNull();
    click('menu-delete');
    expect(asked).toEqual([[{ layer: 'walk-a' }, { layer: 'walk-b' }, { layer: 'walk-c' }]]);
  });

  it('a basemap or a retired viewer offers no Delete…', () => {
    render(null, withKept);
    // a retired viewer has no row at all
    expect(q('tree-row-lg')).toBeNull();
    rightClick('tree-row-bm');
    expect(q('menu-delete')).toBeNull();
    // the Maps header holds only the basemap: nothing to carry, so no menu either
    rightClick('tree-group-maps');
    expect(q('menu-delete')).toBeNull();
    click('tree-row-bm', { ctrlKey: true });
    click('tree-row-walk-a', { ctrlKey: true });
    click('tree-marked-delete');
    expect(asked).toEqual([[{ layer: 'walk-a' }]]);
  });
});
