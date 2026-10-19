// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announced } from '../announce';
import { DatasetTree, type DatasetTreeProps, type MeasureTreeProps } from './DatasetTree';
import { measureMark, measurementsGroup, type TreeGroup, type TreeItem } from './model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
});

const m = (id: string, name: string, extra: Partial<NonNullable<TreeItem['measure']>> = {}) =>
  ({
    id: measureMark(id),
    name,
    meta: '42.18 m',
    measure: { id, color: '#ef476f', dimmed: false, ...extra },
  }) satisfies TreeItem;
const folder = (name: string, children: TreeItem[]): TreeItem => ({
  id: `measure-folder:${name}`,
  name,
  folder: name,
  meta: String(children.length),
  children,
});
const group = (items: TreeItem[]): TreeGroup => {
  const g = measurementsGroup(items);
  if (!g) throw new Error('no measurements');
  return g;
};
const ITEMS: TreeItem[] = [
  folder('Fence', [m('b', 'Line B'), m('c', 'Line C')]),
  m('a', 'Line A'),
  m('s1', 'Survey line', { dimmed: true, dimmedWhy: 'Hidden with 2 Oct 2024' }),
];

const measures = (over: Partial<MeasureTreeProps> = {}): MeasureTreeProps => ({
  hidden: {},
  selectedId: null,
  onSetVisible: vi.fn(),
  onSelect: vi.fn(),
  onMenu: vi.fn(),
  renaming: null,
  onRenameStart: vi.fn(),
  onRename: vi.fn(),
  onRenameEnd: vi.fn(),
  newFolder: null,
  onNewFolder: vi.fn(),
  reveal: null,
  ...over,
});
const props = (
  over: Partial<DatasetTreeProps> = {},
  mOver: Partial<MeasureTreeProps> = {},
  items: TreeItem[] = ITEMS,
): DatasetTreeProps => ({
  groups: [group(items)],
  hidden: {},
  selectedId: null,
  activeClip: null,
  collapsed: false,
  onToggleVisible: vi.fn(),
  onSetVisible: vi.fn(),
  onSelect: vi.fn(),
  onMark: vi.fn(),
  defaultOpen: ['measurements'],
  measures: measures(mOver),
  ...over,
});
const render = (p: DatasetTreeProps) => {
  root ??= createRoot(host);
  act(() => root?.render(<DatasetTree {...p} />));
  return p;
};

const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const row = (id: string) => q(`[data-testid="measure-row"][data-id="${id}"]`);
const must = (el: Element | null | undefined): HTMLElement => {
  if (!(el instanceof HTMLElement)) throw new Error('no element');
  return el;
};
const groupEye = () => must(q('[data-testid="tree-group-measurements"] > .eye'));
const folderEye = (name: string) =>
  must(q(`[data-testid="measure-folder"][data-folder="${name}"] > .eye`));
const click = (el: Element | null | undefined, init: MouseEventInit = {}) => {
  act(() => {
    must(el).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
};
const keyDown = (el: Element | null | undefined, key: string, init: KeyboardEventInit = {}) => {
  act(() => {
    must(el).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
};
const contextMenu = (el: Element | null | undefined, x: number, y: number) => {
  act(() => {
    must(el).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  });
};

describe('measurement rows in the dataset tree', () => {
  it('draws a row with swatch, label, value and eye; the eye hides it', () => {
    const p = render(props());
    const r = must(row('a'));
    expect(r.getAttribute('role')).toBe('treeitem');
    expect(r.dataset.mark).toBe('measure:a');
    expect(r.querySelector('.tsw')?.getAttribute('style')).toContain('--sw: #ef476f');
    expect(r.querySelector('.tn')?.textContent).toBe('Line A');
    expect(r.querySelector('.tm')?.textContent).toBe('42.18 m');
    const eye = r.querySelector('[data-testid="measure-row-eye"]');
    expect(eye?.getAttribute('aria-label')).toBe('Hide Line A');
    expect(eye?.getAttribute('aria-pressed')).toBe('true');
    click(eye);
    expect(p.measures?.onSetVisible).toHaveBeenCalledWith(['a'], false);
    expect(p.measures?.onSelect).not.toHaveBeenCalled();
    expect(p.onSelect).not.toHaveBeenCalled();
    click(r.querySelector('.tn'));
    expect(p.measures?.onSelect).toHaveBeenCalledWith('a');
  });

  it('draws a row hidden by its own eye, and the selected one', () => {
    render(props({}, { hidden: { a: true }, selectedId: 'c' }));
    expect(row('a')?.classList.contains('hidden')).toBe(true);
    expect(
      row('a')?.querySelector('[data-testid="measure-row-eye"]')?.getAttribute('aria-pressed'),
    ).toBe('false');
    expect(row('c')?.classList.contains('sel')).toBe(true);
    expect(row('c')?.getAttribute('aria-selected')).toBe('true');
  });

  it('the group and folder eyes show a mixed state and show all from it', () => {
    const p = render(props({}, { hidden: { b: true } }));
    expect(groupEye().dataset.visibility).toBe('mixed');
    expect(folderEye('Fence').dataset.visibility).toBe('mixed');
    click(folderEye('Fence'));
    expect(p.measures?.onSetVisible).toHaveBeenCalledWith(['b', 'c'], true);
    click(groupEye());
    expect(p.measures?.onSetVisible).toHaveBeenCalledWith(['b', 'c', 'a', 's1'], true);
    expect(p.onSetVisible).not.toHaveBeenCalled();
  });

  it('a folder row shows its count and folds its rows', () => {
    render(props());
    const f = must(q('[data-testid="measure-folder"][data-folder="Fence"]'));
    expect(f.querySelector('.tn')?.textContent).toBe('Fence');
    expect(f.querySelector('.tm')?.textContent).toBe('2');
    expect(row('b')).not.toBeNull();
    click(f);
    expect(row('b')).toBeNull();
    expect(row('a')).not.toBeNull();
  });

  it('the heading and a folder have no menu and keep the right-click and menu keys', () => {
    const onGroupMenu = vi.fn();
    render(props({ onGroupMenu }));
    const outer = vi.fn();
    document.body.addEventListener('contextmenu', outer);
    document.body.addEventListener('keydown', outer);
    for (const el of [
      q('[data-testid="tree-group-measurements"]'),
      q('[data-testid="measure-folder"][data-folder="Fence"]'),
    ]) {
      contextMenu(el, 20, 20);
      keyDown(el, 'F10', { shiftKey: true });
    }
    expect(onGroupMenu).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener('contextmenu', outer);
    document.body.removeEventListener('keydown', outer);
  });

  it('marks with namespaced ids, opens the menu, renames with a 200 cap', () => {
    const p = render(props({ marked: new Set(['measure:c']) }));
    expect(row('c')?.classList.contains('marked')).toBe(true);
    click(row('a')?.querySelector('.tn'), { ctrlKey: true });
    expect(p.onMark).toHaveBeenCalledWith(
      'measure:a',
      { ctrl: true, shift: false },
      expect.arrayContaining(['measure:a']),
    );
    expect(p.measures?.onSelect).not.toHaveBeenCalled();
    contextMenu(row('a'), 30, 40);
    expect(p.measures?.onMenu).toHaveBeenCalledWith('a', { x: 30, y: 40 });
    keyDown(row('a'), 'F10', { shiftKey: true });
    expect(p.measures?.onMenu).toHaveBeenCalledTimes(2);
    keyDown(row('a'), 'F2');
    expect(p.measures?.onRenameStart).toHaveBeenCalledWith('a');
    render({ ...p, measures: { ...must2(p.measures), renaming: 'a' } });
    const field = q('[data-testid="measure-rename"]') as HTMLInputElement;
    expect(field.maxLength).toBe(200);
    expect(field.getAttribute('aria-label')).toBe('Name of Line A');
    field.value = 'Fence post';
    keyDown(field, 'Enter');
    expect(p.measures?.onRename).toHaveBeenCalledWith('a', 'Fence post');
    expect(p.measures?.onRenameEnd).toHaveBeenCalled();
  });

  it('Ctrl+Space and Shift+Arrow mark measurement rows from the keyboard', () => {
    const p = render(props());
    keyDown(row('a'), ' ', { ctrlKey: true });
    expect(p.onMark).toHaveBeenCalledWith(
      'measure:a',
      { ctrl: true, shift: false },
      expect.arrayContaining(['measure:a', 'measure:b']),
    );
    keyDown(row('a'), 'ArrowDown', { shiftKey: true });
    expect(p.onMark).toHaveBeenLastCalledWith(
      'measure:s1',
      { ctrl: false, shift: true, from: 'measure:a' },
      ['measure:b', 'measure:c', 'measure:a', 'measure:s1'],
    );
  });

  it('a dimmed row keeps its own eye open', () => {
    vi.useFakeTimers();
    try {
      render(props());
      const r = must(row('s1'));
      expect(r.classList.contains('dim')).toBe(true);
      expect(r.classList.contains('hidden')).toBe(false);
      expect(r.querySelector('[data-testid="measure-row-eye"]')?.getAttribute('aria-pressed')).toBe(
        'true',
      );
      // why it is dimmed: the app's tip (no native title), on hover and keyboard focus
      expect(r.hasAttribute('title')).toBe(false);
      act(() => {
        r.focus();
      });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Hidden with 2 Oct 2024',
      );
      expect(r.getAttribute('aria-describedby')).toBe(
        document.querySelector('[role="tooltip"]')?.id,
      );
      expect(row('a')?.hasAttribute('aria-describedby')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps 500 measurement rows per folder until More', () => {
    const many = (from: number) =>
      Array.from({ length: 250 }, (_, i) => m(`m${String(from + i)}`, `M ${String(from + i)}`));
    const items = [folder('Big', many(0)), ...many(250)];
    const p = render(props({}, {}, items));
    expect(qa('[data-testid="measure-row"]').length).toBe(16); // 8 + 8
    expect(qa('.titem.more').map((b) => b.textContent)).toEqual(['242 more', '242 more']);
    render({ ...p, measures: { ...must2(p.measures), reveal: { id: 'm499', seq: 1 } } });
    expect(row('m499')).not.toBeNull();
    render({ ...p, measures: { ...must2(p.measures), selectedId: 'm200' } });
    expect(row('m200')).not.toBeNull();
    click(qa('.titem.more')[0]);
    expect(qa('[data-testid="measure-row"]').length).toBe(250 + 9);
  });

  it('reveal opens a closed group and folder and scrolls the row into view', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const p = render(props({ defaultOpen: [] }));
    // open the group, close the folder, close the group again
    click(q('[data-testid="tree-group-toggle-measurements"]'));
    click(q('[data-testid="measure-folder"][data-folder="Fence"]'));
    click(q('[data-testid="tree-group-toggle-measurements"]'));
    expect(row('b')).toBeNull();
    render({ ...p, measures: { ...must2(p.measures), reveal: { id: 'b', seq: 1 } } });
    expect(row('b')).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts[0]).toBe(row('b'));
  });

  it('a reveal in the rail scrolls once the sidebar unfolds', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const p = render(props({ collapsed: true }));
    render({ ...p, measures: { ...must2(p.measures), reveal: { id: 'a', seq: 1 } } });
    expect(scrollIntoView).not.toHaveBeenCalled();
    render({
      ...p,
      collapsed: false,
      measures: { ...must2(p.measures), reveal: { id: 'a', seq: 1 } },
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    render({
      ...p,
      collapsed: false,
      measures: { ...must2(p.measures), reveal: { id: 'a', seq: 1 } },
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('a new folder row asks for a name and hands it over', () => {
    const p = render(props({ defaultOpen: [] }, { newFolder: { ids: ['a'], seq: 1 } }));
    const field = q('[data-testid="measure-folder-new"]') as HTMLInputElement;
    expect(field.maxLength).toBe(200);
    expect(field.getAttribute('aria-label')).toBe('Name of the new folder');
    expect(field.value).toBe('');
    field.value = 'Kerbs';
    keyDown(field, 'Enter');
    expect(p.measures?.onNewFolder).toHaveBeenCalledWith('Kerbs');
    expect(p.measures?.onNewFolder).toHaveBeenCalledTimes(1);
  });

  it('an empty or cancelled new folder hands over null', () => {
    const p = render(props({}, { newFolder: { ids: ['a'], seq: 1 } }));
    keyDown(q('[data-testid="measure-folder-new"]'), 'Escape');
    expect(p.measures?.onNewFolder).toHaveBeenCalledWith(null);
    expect(q('[data-testid="measure-folder-new"]')).toBeNull();
    render({ ...p, measures: { ...must2(p.measures), newFolder: { ids: ['a'], seq: 2 } } });
    keyDown(q('[data-testid="measure-folder-new"]'), 'Enter');
    expect(p.measures?.onNewFolder).toHaveBeenLastCalledWith(null);
    expect(p.measures?.onNewFolder).toHaveBeenCalledTimes(2);
  });
});

describe('the filter box of the Measurements group', () => {
  const box = () => host.querySelector<HTMLInputElement>('[data-testid="measure-filter"]');
  /** The group as the app builds it under a filter: these matches out of every id. */
  const filtered = (items: TreeItem[], all: string[]): TreeGroup => {
    const g = measurementsGroup(items, all);
    if (!g) throw new Error('no measurements');
    return g;
  };
  const ALL = ['b', 'c', 'a', 's1'];

  it('shows in the open group and hands over what is typed', () => {
    const p = render(props({}, { query: '', onQuery: vi.fn() }));
    const input = box();
    if (!input) throw new Error('no filter box');
    expect(input.type).toBe('search');
    expect(input.placeholder).toBe('Filter measurements');
    expect(input.getAttribute('aria-label')).toBe('Filter measurements');
    expect(q('[data-testid="measure-filter-clear"]')).toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'crew',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(p.measures?.onQuery).toHaveBeenCalledWith('crew');
    // a folded group, or a tree with no filter to offer, has no box
    click(q('[data-testid="tree-group-toggle-measurements"]'));
    expect(box()).toBeNull();
    render(props());
    expect(box()).toBeNull();
  });

  it('the clear button and Escape empty it; an empty box leaves Escape alone', () => {
    const onQuery = vi.fn();
    render(props({ groups: [filtered([m('a', 'Line A')], ALL)] }, { query: 'line a', onQuery }));
    click(q('[data-testid="measure-filter-clear"]'));
    expect(onQuery).toHaveBeenLastCalledWith('');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      must(box()).dispatchEvent(esc);
    });
    expect(onQuery).toHaveBeenCalledTimes(2);
    expect(esc.defaultPrevented).toBe(true);
    render(props({}, { query: '', onQuery }));
    const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      must(box()).dispatchEvent(esc2);
    });
    expect(onQuery).toHaveBeenCalledTimes(2);
    expect(esc2.defaultPrevented).toBe(false);
  });

  it('under a filter: matches only, folders open, the header says how many of all', () => {
    const p = render(props({}, { query: '', onQuery: vi.fn() }));
    // the folder was folded by hand before the filter
    click(q('[data-testid="measure-folder"][data-folder="Fence"]'));
    expect(row('b')).toBeNull();
    const items = [{ ...folder('Fence', [m('b', 'Line B')]), folderIds: ['b', 'c'] }];
    render({
      ...p,
      groups: [filtered(items, ALL)],
      measures: { ...must2(p.measures), query: 'b' },
    });
    expect(row('b')).not.toBeNull();
    expect(row('c')).toBeNull();
    expect(row('a')).toBeNull();
    const f = must(q('[data-testid="measure-folder"][data-folder="Fence"]'));
    // the folder says how many of its own, as the group does, since its eye covers them all
    expect(f.querySelector('.tm')?.textContent).toBe('1 of 2');
    expect(q('[data-testid="tree-group-measurements"] .gcount')?.textContent).toBe('1 of 4');
    // the eyes act on all they did before the filter
    click(folderEye('Fence'));
    expect(p.measures?.onSetVisible).toHaveBeenLastCalledWith(['b', 'c'], false);
    click(groupEye());
    expect(p.measures?.onSetVisible).toHaveBeenLastCalledWith(ALL, false);
  });

  it('under a filter a folder does not fold: no chevron, and a click leaves it as it was', () => {
    const p = render(props({}, { query: '', onQuery: vi.fn() }));
    const items = [{ ...folder('Fence', [m('b', 'Line B')]), folderIds: ['b', 'c'] }];
    render({
      ...p,
      groups: [filtered(items, ALL)],
      measures: { ...must2(p.measures), query: 'b' },
    });
    const f = () => must(q('[data-testid="measure-folder"][data-folder="Fence"]'));
    expect(f().querySelector('.chev')?.classList.contains('chev-off')).toBe(true);
    // said to assistive tech too: the fold does nothing here
    // said to assistive tech on the folder's treeitem: the fold does nothing here
    const item = () => f().closest('[role="treeitem"]');
    expect(item()?.getAttribute('aria-description')).toBe('Folders stay open while filtering');
    expect(qa('[aria-disabled]')).toEqual([]);
    click(f());
    keyDown(f(), 'Enter');
    expect(row('b')).not.toBeNull();
    // the filter cleared: the folder is open as before it, not folded by those clicks
    render({ ...p, measures: { ...must2(p.measures), query: '' } });
    expect(row('b')).not.toBeNull();
    expect(row('c')).not.toBeNull();
    expect(f().querySelector('.chev')?.classList.contains('chev-off')).toBe(false);
    expect(item()?.hasAttribute('aria-description')).toBe(false);
    expect(f().querySelector('.tm')?.textContent).toBe('2');
  });

  it('under a filter every match shows, past the "more" cap', () => {
    const many = Array.from({ length: 30 }, (_, i) => m(`m${String(i)}`, `M ${String(i)}`));
    const all = [...many.map((x) => x.measure.id), 'other'];
    render(props({ groups: [filtered(many, all)] }, { query: 'm', onQuery: vi.fn() }));
    expect(qa('[data-testid="measure-row"]').length).toBe(30);
    expect(qa('.titem.more')).toEqual([]);
  });

  it('a screen reader hears how many match as the filter changes, through the live region', () => {
    const p = render(props({}, { query: '', onQuery: vi.fn() }));
    const before = announced().polite;
    const items = [{ ...folder('Fence', [m('b', 'Line B')]), folderIds: ['b', 'c'] }];
    render({
      ...p,
      groups: [filtered(items, ALL)],
      measures: { ...must2(p.measures), query: 'b' },
    });
    expect(announced().polite.trim()).toBe('1 of 4 measurements match');
    render({ ...p, groups: [filtered([], ALL)], measures: { ...must2(p.measures), query: 'zz' } });
    expect(announced().polite.trim()).toBe('No measurements match');
    // the line in the tree is for the eye; the live region, mounted always, does the telling
    expect(q('[data-testid="measure-filter-none"]')?.getAttribute('role')).toBeNull();
    expect(before).not.toBe(announced().polite);
  });

  it('no match: the group stays with its box and says so', () => {
    render(props({ groups: [filtered([], ALL)] }, { query: 'zz', onQuery: vi.fn() }));
    expect(box()).not.toBeNull();
    expect(q('[data-testid="measure-filter-none"]')?.textContent).toBe('No measurements match');
    expect(qa('[data-testid="measure-row"]')).toEqual([]);
    expect(q('[data-testid="tree-group-measurements"] .gcount')?.textContent).toBe('0 of 4');
  });
});

function must2<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}
