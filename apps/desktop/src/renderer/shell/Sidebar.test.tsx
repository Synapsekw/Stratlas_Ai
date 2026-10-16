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
const press = (id: string, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
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

  it('Ctrl+Space and Shift+ArrowDown mark rows from the keyboard; Delete asks for them', () => {
    render(null);
    press('tree-row-walk-a', ' ', { ctrlKey: true });
    expect(q('tree-marked-delete')?.textContent).toBe('1 selected · Delete…');
    press('tree-row-walk-a', 'ArrowDown', { shiftKey: true });
    expect(document.activeElement).toBe(q('tree-row-walk-b'));
    press('tree-row-walk-b', 'ArrowDown', { shiftKey: true });
    expect(q('tree-marked-delete')?.textContent).toBe('3 selected · Delete…');
    press('tree-row-walk-c', 'ArrowUp', { shiftKey: true });
    expect(q('tree-marked-delete')?.textContent).toBe('2 selected · Delete…');
    press('tree-row-walk-b', 'Delete');
    expect(asked).toEqual([[{ layer: 'walk-a' }, { layer: 'walk-b' }]]);
  });

  it('Delete on a focused row with nothing marked asks for that row, in the dialog', () => {
    render(null);
    const del = press('tree-row-walk-c', 'Delete');
    expect(del.defaultPrevented).toBe(true);
    expect(asked).toEqual([[{ layer: 'walk-c' }]]);
    // a group header is not a row: nothing is asked
    press('tree-group-walks', 'Delete');
    expect(asked).toHaveLength(1);
  });

  it('a reviewer who may only look deletes nothing from the keyboard', () => {
    h.readOnly = true;
    render(null);
    press('tree-row-walk-a', ' ', { ctrlKey: true });
    press('tree-row-walk-a', 'Delete');
    expect(q('tree-marked-delete')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('keeps the show and hide eye in the header while rows are marked', () => {
    render(null);
    const eye = () => document.body.querySelector('.tree-h [data-visibility]');
    expect(eye()?.getAttribute('aria-label')).toBe('Hide all layers');
    click('tree-row-walk-a', { ctrlKey: true });
    expect(q('tree-marked-delete')).not.toBeNull();
    expect(eye()?.getAttribute('aria-label')).toBe('Hide all layers');
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
    // with nothing marked, Delete in the field is still the field's
    press('tree-row-walk-b', 'Escape');
    press('date-name-c1', 'F2');
    expect(press('date-rename', 'Delete').defaultPrevented).toBe(false);
    expect(asked).toEqual([]);
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

describe('Datasets: menus', () => {
  const rightClickAt = (el: Element) => {
    act(() => {
      el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 30,
          clientY: 30,
        }),
      );
    });
  };

  it('a right-click on empty space opens the project menu, on a row it does not', () => {
    render(null);
    rightClickAt(document.body.querySelector('.sb-tree .tree-h') ?? document.body);
    expect(q('ctx-menu')).not.toBeNull();
    expect(q('ctx-item-project.addData')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(q('ctx-menu')).toBeNull();
    rightClick('tree-row-walk-a');
    expect(q('ctx-menu')).toBeNull();
    expect(q('move-menu')).not.toBeNull();
  });

  it('Shift+F10 with focus in the section header opens the project menu', () => {
    render(null);
    const header = document.body.querySelector('.sb-tree .tree-h');
    const e = new KeyboardEvent('keydown', {
      key: 'F10',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      header?.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    expect(q('ctx-item-project.addData')).not.toBeNull();
  });

  it('a basemap row opens a menu', () => {
    render(null, withKept);
    rightClick('tree-row-bm');
    expect(q('move-menu')).not.toBeNull();
  });

  it('the Issues row opens a menu', () => {
    const issue = {
      id: 'i1',
      status: 'draft',
    };
    render(null);
    act(() => {
      workspace.setState({ issues: [issue] } as unknown as Partial<
        ReturnType<typeof workspace.getState>
      >);
    });
    const row = [...document.body.querySelectorAll('.titem')].find((el) =>
      el.textContent.startsWith('Issues'),
    );
    if (!row) throw new Error('no Issues row');
    rightClickAt(row);
    expect(q('ctx-menu')).not.toBeNull();
    expect(q('ctx-item-annotations.open')).not.toBeNull();
  });

  it('a right-click inside the Empty trash dialog opens no menu', () => {
    render({ bytes: 1024, entries: 2 });
    click('tree-trash-empty');
    rightClickAt(q('trash-empty') ?? document.body);
    expect(q('ctx-menu')).toBeNull();
  });

  it('Shift+F10 on a button inside a row opens that row’s menu', () => {
    render(null);
    const e = new KeyboardEvent('keydown', {
      key: 'F10',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      q('walk-remove-walk-a')?.dispatchEvent(e);
    });
    expect(q('move-menu')).not.toBeNull();
    expect(q('ctx-menu')).toBeNull();
  });

  it('marked rows open one menu for all of them', () => {
    render(null);
    click('tree-row-walk-a', { ctrlKey: true });
    click('tree-row-walk-b', { ctrlKey: true });
    rightClick('tree-row-walk-a');
    expect(q('move-menu')?.textContent).toContain('2 datasets');
    click('menu-delete');
    expect(asked).toEqual([[{ layer: 'walk-a' }, { layer: 'walk-b' }]]);
  });
});
