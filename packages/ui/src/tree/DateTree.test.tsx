// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DateTag } from '@aio/workspace';
import { DateTree, type DateItemMenuRequest, type DateTreeProps } from './DateTree';
import type { DateFolder } from './dateModel';
import type { TreeGroup } from './model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const group = (ids: string[]): TreeGroup => ({
  kind: 'models',
  label: 'Models',
  icon: 'scene',
  count: ids.length,
  items: ids.map((id) => ({ id, layerId: id, layerKind: 'mesh', name: id })),
});
const cap = (id: string, date: string) => ({ id, label: id, date });
const folders: DateFolder[] = [
  {
    id: 'every',
    capture: null,
    label: 'Every date',
    groups: [group(['site'])],
    layerIds: ['site'],
  },
  {
    id: 'nov',
    capture: cap('nov', '2024-11-06'),
    label: '6 Nov 2024',
    groups: [group(['m-nov'])],
    layerIds: ['m-nov'],
  },
  {
    id: 'oct',
    capture: cap('oct', '2024-10-02'),
    label: '2 Oct 2024',
    groups: [group(['m-oct'])],
    layerIds: ['m-oct'],
  },
  { id: 'sep', capture: cap('sep', '2024-09-04'), label: '4 Sep 2024', groups: [], layerIds: [] },
];
const tags: Record<string, DateTag> = {
  sep: {
    id: 'sep',
    date: '2024-09-04',
    order: 0,
    colour: 'var(--date-1)',
    short: '4 Sep',
    long: '4 Sep 2024',
  },
  oct: {
    id: 'oct',
    date: '2024-10-02',
    order: 1,
    colour: 'var(--date-2)',
    short: '2 Oct',
    long: '2 Oct 2024',
  },
  nov: {
    id: 'nov',
    date: '2024-11-06',
    order: 2,
    colour: 'var(--date-3)',
    short: '6 Nov',
    long: '6 Nov 2024',
  },
};

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  host.remove();
});

function render(
  focus: string,
  hidden: Record<string, true>,
  onFocus = vi.fn(),
  extra: Partial<DateTreeProps> = {},
) {
  const root = createRoot(host);
  const props: DateTreeProps = {
    folders,
    tags,
    focus,
    onFocus,
    hidden,
    selectedId: null,
    activeClip: null,
    onToggleVisible: vi.fn(),
    onSetVisible: vi.fn(),
    onSelect: vi.fn(),
    ...extra,
  };
  act(() => {
    root.render(<DateTree {...props} />);
  });
  return { root, props, onFocus };
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

/** A drag event as the browser sends it (jsdom has no DragEvent), with a data transfer to fill. */
function fire(el: Element | null, type: string, init: { relatedTarget?: Element | null } = {}) {
  if (!el) throw new Error(`no element for ${type}`);
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', {
    value: { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() },
  });
  Object.defineProperty(e, 'relatedTarget', { value: init.relatedTarget ?? null });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
}
/** A right-click at a point of the window. */
function rightClick(el: Element | null, x: number, y: number) {
  if (!el) throw new Error('no element to right-click');
  act(() => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  });
}
function key(el: Element | null, k: string) {
  if (!el) throw new Error('no element for the key');
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}
/** A full render with other folders or tags than the shared ones. */
function renderWith(extra: Partial<DateTreeProps>) {
  const root = createRoot(host);
  act(() => {
    root.render(
      <DateTree
        folders={folders}
        tags={tags}
        focus="nov"
        onFocus={vi.fn()}
        hidden={{}}
        selectedId={null}
        activeClip={null}
        onToggleVisible={vi.fn()}
        onSelect={vi.fn()}
        {...extra}
      />,
    );
  });
}

describe('DateTree', () => {
  it('expands only the focused date and marks it current', () => {
    render('nov', { 'm-oct': true });
    expect(q('date-folder-nov')?.getAttribute('aria-expanded')).toBe('true');
    expect(q('date-folder-oct')?.getAttribute('aria-expanded')).toBe('false');
    expect(q('date-name-nov')?.getAttribute('aria-current')).toBe('date');
  });

  it('clicking a date name focuses it', () => {
    const { onFocus } = render('nov', {});
    act(() => {
      (q('date-name-oct') as HTMLButtonElement).click();
    });
    expect(onFocus).toHaveBeenCalledWith('oct');
  });

  it('re-opens a collapsed focused date when its name is clicked', () => {
    const { onFocus } = render('nov', {});
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="date-folder-nov"] .dchev')?.click();
    });
    expect(q('date-folder-nov')?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      (q('date-name-nov') as HTMLButtonElement).click();
    });
    expect(q('date-folder-nov')?.getAttribute('aria-expanded')).toBe('true');
    expect(onFocus).toHaveBeenCalledWith('nov');
  });

  it('collapses other dates when focus changes', () => {
    const { root, props } = render('nov', {});
    act(() => {
      root.render(<DateTree {...props} focus="oct" />);
    });
    expect(q('date-folder-oct')?.getAttribute('aria-expanded')).toBe('true');
    expect(q('date-folder-nov')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the count of visible layers on a collapsed non-focused date', () => {
    render('nov', {}); // m-oct visible = extra
    expect(q('date-on-oct')?.textContent).toBe('1 on');
    expect(q('date-on-nov')).toBeNull();
  });

  it('greys an empty date', () => {
    render('nov', {});
    expect(q('date-folder-sep')?.className).toContain('empty');
  });
});

describe('DateTree: dragging a dataset onto a date folder', () => {
  it('rows do not drag in a read-only project', () => {
    render('nov', {});
    expect(q('tree-row-m-nov')?.getAttribute('draggable')).toBeNull();
    fire(q('tree-row-m-nov'), 'dragstart');
    expect(q('date-folder-oct')?.className).not.toContain('drop-can');
  });

  it('marks the folders that take the drop, and the one under the pointer', () => {
    render('nov', {}, vi.fn(), { onMove: vi.fn() });
    expect(q('tree-row-m-nov')?.getAttribute('draggable')).toBe('true');
    fire(q('tree-row-m-nov'), 'dragstart');
    // every folder but the row's own
    expect(q('date-folder-oct')?.className).toContain('drop-can');
    expect(q('date-folder-every')?.className).toContain('drop-can');
    expect(q('date-folder-nov')?.className).not.toContain('drop-can');
    const over = fire(q('date-folder-oct'), 'dragover');
    expect(over.defaultPrevented).toBe(true);
    expect(q('date-folder-oct')?.className).toContain('drop-over');
    fire(q('date-folder-oct'), 'dragleave');
    expect(q('date-folder-oct')?.className).not.toContain('drop-over');
    fire(q('tree-row-m-nov'), 'dragend');
    expect(q('date-folder-oct')?.className).not.toContain('drop-can');
  });

  it('a drop files the row under that date, and under none on Every date', () => {
    const onMove = vi.fn();
    render('nov', {}, vi.fn(), { onMove });
    fire(q('tree-row-m-nov'), 'dragstart');
    fire(q('date-folder-oct'), 'dragover');
    fire(q('date-folder-oct'), 'drop');
    expect(onMove).toHaveBeenLastCalledWith(['m-nov'], 'oct');
    expect(q('date-folder-oct')?.className).not.toContain('drop-over');
    fire(q('tree-row-m-nov'), 'dragstart');
    fire(q('date-folder-every'), 'drop');
    expect(onMove).toHaveBeenLastCalledWith(['m-nov'], null);
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it('a drop on the folder the row is already in does nothing', () => {
    const onMove = vi.fn();
    render('nov', {}, vi.fn(), { onMove });
    fire(q('tree-row-m-nov'), 'dragstart');
    const over = fire(q('date-folder-nov'), 'dragover');
    expect(over.defaultPrevented).toBe(false);
    fire(q('date-folder-nov'), 'drop');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('leaves the highlight on while the pointer moves inside the folder', () => {
    render('nov', {}, vi.fn(), { onMove: vi.fn() });
    fire(q('tree-row-m-nov'), 'dragstart');
    fire(q('date-folder-oct'), 'dragover');
    fire(q('date-folder-oct'), 'dragleave', { relatedTarget: q('date-name-oct') });
    expect(q('date-folder-oct')?.className).toContain('drop-over');
  });

  it('offers Every date as a drop place while dragging when every dataset is dated', () => {
    const onMove = vi.fn();
    renderWith({ folders: folders.filter((f) => f.id !== 'every'), onMove });
    expect(q('date-folder-every')).toBeNull();
    fire(q('tree-row-m-nov'), 'dragstart');
    expect(q('date-folder-every')?.className).toContain('drop-can');
    fire(q('date-folder-every'), 'drop');
    expect(onMove).toHaveBeenCalledWith(['m-nov'], null);
    expect(q('date-folder-every')).toBeNull();
  });
});

describe('DateTree: menus and renaming', () => {
  it('a right-click on a folder asks for its menu, with how the folder stands', () => {
    const onFolderMenu = vi.fn();
    render('nov', {}, vi.fn(), { onFolderMenu });
    rightClick(host.querySelector('[data-testid="date-folder-oct"] .dfolder-row'), 40, 60);
    expect(onFolderMenu).toHaveBeenCalledTimes(1);
    const m = onFolderMenu.mock.calls[0]?.[0] as {
      folder: DateFolder;
      expanded: boolean;
      toggle: () => void;
    };
    expect(m).toMatchObject({ x: 40, y: 60, expanded: false });
    expect(m.folder.id).toBe('oct');
    act(() => {
      m.toggle();
    });
    expect(q('date-folder-oct')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('the more button opens the same menu without a right-click', () => {
    const onFolderMenu = vi.fn();
    render('nov', {}, vi.fn(), { onFolderMenu });
    act(() => {
      (q('date-more-nov') as HTMLButtonElement).click();
    });
    expect(onFolderMenu.mock.calls[0]?.[0]).toMatchObject({ expanded: true });
    expect(q('date-more-every')).not.toBeNull();
  });

  it('has no more button without a menu to open', () => {
    render('nov', {});
    expect(q('date-more-nov')).toBeNull();
  });

  it('a right-click on a dataset asks for its menu with the layers and its folder', () => {
    const onItemMenu = vi.fn();
    render('nov', {}, vi.fn(), { onItemMenu });
    rightClick(q('tree-row-m-nov'), 12, 34);
    expect(onItemMenu).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'm-nov', layerIds: ['m-nov'], from: 'nov', x: 12, y: 34 }),
    );
  });

  it('shows the name field of the date being renamed and saves on Enter', () => {
    const onRename = vi.fn();
    const onRenameEnd = vi.fn();
    render('nov', {}, vi.fn(), { renaming: 'oct', onRename, onRenameEnd });
    const field = q('date-rename') as HTMLInputElement;
    expect(field.getAttribute('aria-label')).toBe('Name of 2 Oct 2024');
    expect(q('date-name-oct')).toBeNull();
    expect(q('date-name-nov')).not.toBeNull();
    field.value = '  Baseline  ';
    key(field, 'Enter');
    expect(onRename).toHaveBeenCalledWith('oct', 'Baseline');
    expect(onRenameEnd).toHaveBeenCalledTimes(1);
    // leaving the field afterwards does not save twice
    act(() => {
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRenameEnd).toHaveBeenCalledTimes(1);
  });

  it('Escape leaves the name as it was, and so does an unchanged name', () => {
    const onRename = vi.fn();
    const onRenameEnd = vi.fn();
    const { root, props } = render('nov', {}, vi.fn(), { renaming: 'oct', onRename, onRenameEnd });
    const field = q('date-rename') as HTMLInputElement;
    field.value = 'Something else';
    key(field, 'Escape');
    expect(onRename).not.toHaveBeenCalled();
    expect(onRenameEnd).toHaveBeenCalledTimes(1);
    act(() => {
      root.render(<DateTree {...props} renaming="nov" />);
    });
    key(q('date-rename'), 'Enter');
    expect(onRename).not.toHaveBeenCalled();
    expect(onRenameEnd).toHaveBeenCalledTimes(2);
  });

  it('leaving the name field saves it, an emptied field as no name', () => {
    const onRename = vi.fn();
    renderWith({
      folders: folders.map((f) => (f.id === 'oct' ? { ...f, sub: 'Baseline' } : f)),
      renaming: 'oct',
      onRename,
    });
    const field = q('date-rename') as HTMLInputElement;
    expect(field.value).toBe('Baseline');
    field.value = '';
    act(() => {
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onRename).toHaveBeenCalledWith('oct', '');
  });

  it('marks reach the rows inside date folders', () => {
    renderWith({ marked: new Set(['m-nov']) });
    expect(q('tree-row-m-nov')?.className).toContain('marked');
  });

  it('a Shift range runs over the rows drawn, not those of a closed date folder', () => {
    const orders: (readonly string[])[] = [];
    renderWith({ onMark: (_id, _m, order) => orders.push(order) });
    expect(q('date-folder-oct')?.getAttribute('aria-expanded')).toBe('false');
    const row = q('tree-row-m-nov');
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    expect(orders).toEqual([['site', 'm-nov']]);
    expect(host.querySelector('[role="tree"]')?.getAttribute('aria-multiselectable')).toBe('true');
  });

  it('Shift+ArrowUp crosses from one date folder into the next one up', () => {
    const calls: [string, string | undefined][] = [];
    renderWith({ onMark: (id, m) => calls.push([id, m.from]) });
    const row = q('tree-row-m-nov');
    act(() => {
      row?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }),
      );
    });
    expect(calls).toEqual([['site', 'm-nov']]);
    expect(document.activeElement).toBe(q('tree-row-site'));
  });

  it('F2 on a date name starts renaming it, never on Every date', () => {
    const onRenameStart = vi.fn();
    render('nov', {}, vi.fn(), { onRenameStart });
    key(q('date-name-every'), 'F2');
    expect(onRenameStart).not.toHaveBeenCalled();
    key(q('date-name-oct'), 'F2');
    expect(onRenameStart).toHaveBeenCalledWith('oct');
  });

  it('draws the icon a date was given in place of its colour square', () => {
    const base = tags.oct;
    if (!base) throw new Error('fixture');
    renderWith({
      tags: { ...tags, oct: { ...base, icon: 'flag' }, nov: { ...base, icon: 'not-an-icon' } },
    });
    expect(q('date-name-oct')?.querySelector('svg.dicon')).not.toBeNull();
    expect(q('date-name-oct')?.querySelector('.dtag')).toBeNull();
    // an icon this build does not know falls back to the square
    expect(q('date-name-nov')?.querySelector('.dtag')).not.toBeNull();
  });
});

describe('DateTree: a whole group onto a date folder', () => {
  /** The header of a group inside a folder. */
  const head = (folder: string, kind = 'models') =>
    host.querySelector(`[data-testid="date-folder-${folder}"] [data-testid="tree-group-${kind}"]`);
  const many = Array.from({ length: 12 }, (_, i) => `v${String(i)}`);
  const maps: TreeGroup = {
    kind: 'maps',
    label: 'Maps and rasters',
    icon: 'map',
    count: 2,
    items: [
      { id: 'ortho', layerId: 'ortho', layerKind: 'raster', name: 'Ortho' },
      { id: 'base', layerId: 'base', layerKind: 'basemap', name: 'Offline map' },
    ],
  };
  const basemapOnly: TreeGroup = { ...maps, count: 1, items: maps.items.slice(1) };
  const withNov = (groups: TreeGroup[], layerIds: string[]): DateFolder[] =>
    folders.map((f) => (f.id === 'nov' ? { ...f, groups, layerIds } : f));

  it('a group header drags every dataset of its group, the rows behind "more" too', () => {
    const onMove = vi.fn();
    renderWith({ folders: withNov([group(many)], many), onMove });
    expect(head('nov')?.getAttribute('draggable')).toBe('true');
    fire(head('nov'), 'dragstart');
    expect(q('date-folder-oct')?.className).toContain('drop-can');
    fire(q('date-folder-oct'), 'dragover');
    fire(q('date-folder-oct'), 'drop');
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(many, 'oct');
  });

  it('a group dropped on Every date takes the date off its datasets', () => {
    const onMove = vi.fn();
    render('nov', {}, vi.fn(), { onMove });
    fire(head('nov'), 'dragstart');
    fire(q('date-folder-every'), 'drop');
    expect(onMove).toHaveBeenCalledWith(['m-nov'], null);
  });

  it('a group dropped on the folder it is in does nothing', () => {
    const onMove = vi.fn();
    render('nov', {}, vi.fn(), { onMove });
    fire(head('nov'), 'dragstart');
    expect(q('date-folder-nov')?.className).not.toContain('drop-can');
    fire(q('date-folder-nov'), 'drop');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('the highlight goes when the drag of a group ends without a drop', () => {
    render('nov', {}, vi.fn(), { onMove: vi.fn() });
    fire(head('nov'), 'dragstart');
    fire(head('nov'), 'dragend');
    expect(q('date-folder-oct')?.className).not.toContain('drop-can');
  });

  it('a mixed group moves what can be dated and leaves the basemap', () => {
    const onMove = vi.fn();
    renderWith({ folders: withNov([maps], ['ortho', 'base']), onMove });
    fire(head('nov', 'maps'), 'dragstart');
    fire(q('date-folder-oct'), 'drop');
    expect(onMove).toHaveBeenCalledWith(['ortho'], 'oct');
  });

  it('a group with nothing that can be dated stays put and its menu carries no layers', () => {
    const onItemMenu = vi.fn();
    renderWith({ folders: withNov([basemapOnly], ['base']), onMove: vi.fn(), onItemMenu });
    expect(head('nov', 'maps')?.getAttribute('draggable')).toBeNull();
    rightClick(head('nov', 'maps'), 12, 34);
    expect(onItemMenu).toHaveBeenCalledWith(
      expect.objectContaining({ layerIds: [], group: 'maps' }),
    );
  });

  it('group headers do not drag in a read-only project', () => {
    render('nov', {});
    expect(head('nov')?.getAttribute('draggable')).toBeNull();
  });

  it('a right-click on a group header asks for the move menu of the whole group', () => {
    const onItemMenu = vi.fn();
    renderWith({ folders: withNov([group(many)], many), onMove: vi.fn(), onItemMenu });
    rightClick(head('nov'), 12, 34);
    expect(onItemMenu).toHaveBeenCalledTimes(1);
    const asked = onItemMenu.mock.calls[0]?.[0] as DateItemMenuRequest;
    expect(asked).toMatchObject({
      name: 'Models · 12 datasets',
      layerIds: many,
      from: 'nov',
      x: 12,
      y: 34,
    });
    expect(asked.item).toBeUndefined();
  });

  it('the menu key on a focused group header opens the same menu', () => {
    const onItemMenu = vi.fn();
    renderWith({ folders: withNov([group(many)], many), onMove: vi.fn(), onItemMenu });
    // the menu key fires `contextmenu` at the focused button, with no pointer position (0, 0)
    rightClick(head('nov')?.querySelector('.tgroup-btn') ?? null, 0, 0);
    expect(onItemMenu).toHaveBeenCalledTimes(1);
    const asked = onItemMenu.mock.calls[0]?.[0] as DateItemMenuRequest;
    expect(asked).toMatchObject({ layerIds: many, from: 'nov' });
    expect(typeof asked.x).toBe('number');
    expect(typeof asked.y).toBe('number');
  });

  it('adds the line-up sentence to the folder tooltip of a lined-up date', () => {
    renderWith({
      folders: folders.map((f) =>
        f.id === 'oct' ? { ...f, lineUp: 'Lined up with Survey A (2.01 m)' } : f,
      ),
    });
    expect(q('date-name-oct')?.getAttribute('title')).toBe(
      'View 2 Oct 2024\nLined up with Survey A (2.01 m)',
    );
    expect(q('date-name-nov')?.getAttribute('title')).toBe('View 6 Nov 2024');
  });

  it('names a group of one in the singular', () => {
    const onItemMenu = vi.fn();
    render('nov', {}, vi.fn(), { onMove: vi.fn(), onItemMenu });
    rightClick(head('nov'), 1, 1);
    expect(onItemMenu).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Models · 1 dataset' }),
    );
  });
});

describe('DateTree: groups below the date folders', () => {
  const measured = (): TreeGroup => ({
    kind: 'measurements',
    label: 'Measurements',
    icon: 'measure',
    count: 2,
    items: ['a', 'b'].map((id) => ({
      id: `measure:${id}`,
      name: `Line ${id}`,
      measure: { id, color: '#ffd166', dimmed: false },
    })),
  });

  it('draws the after groups once, below the folders', () => {
    const onMark = vi.fn();
    render('nov', {}, vi.fn(), {
      after: [measured()],
      onMark,
      defaultOpen: ['models', 'measurements'],
      measures: {
        hidden: {},
        selectedId: null,
        onSetVisible: vi.fn(),
        onSelect: vi.fn(),
        onMenu: vi.fn(),
        renaming: null,
        onRename: vi.fn(),
        onRenameEnd: vi.fn(),
        newFolder: null,
        onNewFolder: vi.fn(),
        reveal: null,
      },
    });
    const tree = host.querySelector('[role="tree"]');
    expect(host.querySelectorAll('[data-testid="measure-row"]').length).toBe(2);
    expect(host.querySelectorAll('[data-testid="tree-group-measurements"]').length).toBe(1);
    expect(tree?.lastElementChild?.textContent).toContain('Measurements');
    expect(tree?.lastElementChild?.getAttribute('role')).toBe('group');
    // one tree: a Shift range runs over the date folders' rows and the measurements
    const a = host.querySelector('[data-testid="measure-row"][data-id="a"] .tn');
    act(() => {
      a?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    expect(onMark).toHaveBeenCalledWith('measure:a', { ctrl: true, shift: false }, [
      'site',
      'm-nov',
      'measure:a',
      'measure:b',
    ]);
  });
});

describe('DateTree: dragging a measurement', () => {
  const measured = (ids: string[], telecom = false): TreeGroup => ({
    kind: 'measurements',
    label: 'Measurements',
    icon: 'measure',
    count: ids.length,
    items: ids.map((id) => ({
      id: `measure:${id}`,
      name: `Line ${id}`,
      measure: { id, color: '#ffd166', dimmed: false, ...(telecom ? { telecom } : {}) },
    })),
  });
  const withMeasures = (nov: string[], oct: string[], telecom = false): DateFolder[] =>
    folders.map((f) =>
      f.id === 'nov'
        ? { ...f, groups: [...f.groups, measured(nov, telecom)] }
        : f.id === 'oct'
          ? { ...f, groups: [...f.groups, measured(oct)] }
          : f,
    );
  const ids = (it: { measure?: { id: string } | undefined; children?: unknown }) =>
    it.measure ? [it.measure.id] : [];
  const measuresProps = (over: Partial<NonNullable<DateTreeProps['measures']>> = {}) => ({
    hidden: {},
    selectedId: null,
    onSetVisible: vi.fn(),
    onSelect: vi.fn(),
    onMenu: vi.fn(),
    renaming: null,
    onRename: vi.fn(),
    onRenameEnd: vi.fn(),
    newFolder: null,
    onNewFolder: vi.fn(),
    reveal: null,
    dragMeasureIds: ids,
    ...over,
  });
  const base = (extra: Partial<DateTreeProps> = {}): Partial<DateTreeProps> => ({
    folders: withMeasures(['a'], ['b']),
    defaultOpen: ['models', 'measurements'],
    measures: measuresProps(),
    ...extra,
  });
  const mrow = (id: string) => host.querySelector(`[data-testid="measure-row"][data-id="${id}"]`);

  it('offers other date folders, not its own or Every date', () => {
    renderWith(base({ onMoveMeasures: vi.fn() }));
    expect(mrow('a')?.getAttribute('draggable')).toBe('true');
    fire(mrow('a'), 'dragstart');
    expect(q('date-folder-oct')?.className).toContain('drop-can');
    expect(q('date-folder-sep')?.className).toContain('drop-can');
    expect(q('date-folder-nov')?.className).not.toContain('drop-can');
    expect(q('date-folder-every')?.className).not.toContain('drop-can');
    expect(q('date-folder-every')?.className).not.toContain('drop-no');
    // no spare Every date place for a measurement drag
    expect(host.querySelector('.dfolder-spare')).toBeNull();
    fire(mrow('a'), 'dragend');
    expect(q('date-folder-oct')?.className).not.toContain('drop-can');
  });

  it('a drop on another date calls onMoveMeasures with that capture', () => {
    const onMoveMeasures = vi.fn();
    renderWith(base({ onMoveMeasures }));
    fire(mrow('a'), 'dragstart');
    fire(q('date-folder-oct'), 'dragover');
    expect(q('date-folder-oct')?.className).toContain('drop-over');
    fire(q('date-folder-oct'), 'drop');
    expect(onMoveMeasures).toHaveBeenCalledTimes(1);
    expect(onMoveMeasures).toHaveBeenCalledWith(['a'], 'oct');
    // a drop on Every date is not a move
    fire(mrow('a'), 'dragstart');
    fire(q('date-folder-every'), 'drop');
    expect(onMoveMeasures).toHaveBeenCalledTimes(1);
  });

  it('a measurement from the Needs a date group is offered to every date', () => {
    const onMoveMeasures = vi.fn();
    renderWith(base({ onMoveMeasures, after: [measured(['n'])] }));
    fire(mrow('n'), 'dragstart');
    for (const id of ['nov', 'oct', 'sep'])
      expect(q(`date-folder-${id}`)?.className).toContain('drop-can');
    fire(q('date-folder-sep'), 'drop');
    expect(onMoveMeasures).toHaveBeenCalledWith(['n'], 'sep');
  });

  it('an antenna drag shows the date folder refused with the reason', () => {
    const onMoveMeasures = vi.fn();
    renderWith(base({ folders: withMeasures(['a'], ['b'], true), onMoveMeasures }));
    fire(mrow('a'), 'dragstart');
    const oct = q('date-folder-oct');
    expect(oct?.className).toContain('drop-no');
    expect(oct?.className).not.toContain('drop-can');
    expect(oct?.getAttribute('title')).toBe(
      'Antenna measurements stay on the date they were picked on.',
    );
    // the drop still reaches the caller, which refuses it with the same words
    fire(oct, 'drop');
    expect(onMoveMeasures).toHaveBeenCalledWith(['a'], 'oct');
  });

  it('nothing drags without onMoveMeasures and dragMeasureIds (read-only)', () => {
    renderWith(base({ measures: measuresProps({ dragMeasureIds: undefined }) }));
    expect(mrow('a')?.getAttribute('draggable')).toBeNull();
    fire(mrow('a'), 'dragstart');
    expect(q('date-folder-oct')?.className).not.toContain('drop-can');
    // rows may drag within their date, but no date folder takes the drag
    host.replaceChildren();
    renderWith(base());
    fire(mrow('a'), 'dragstart');
    expect(q('date-folder-oct')?.className).not.toContain('drop-can');
  });

  it('a reveal opens the date folder holding the measurement', () => {
    const root = createRoot(host);
    const props = (reveal: { id: string | null; seq: number } | null): DateTreeProps => ({
      folders: withMeasures(['a'], ['b']),
      tags,
      focus: 'nov',
      onFocus: vi.fn(),
      hidden: {},
      selectedId: null,
      activeClip: null,
      onToggleVisible: vi.fn(),
      onSelect: vi.fn(),
      defaultOpen: ['models'],
      measures: measuresProps({ reveal }),
    });
    act(() => {
      root.render(<DateTree {...props(null)} />);
    });
    expect(q('date-folder-oct')?.getAttribute('aria-expanded')).toBe('false');
    expect(mrow('b')).toBeNull();
    act(() => {
      root.render(<DateTree {...props({ id: 'b', seq: 1 })} />);
    });
    expect(q('date-folder-oct')?.getAttribute('aria-expanded')).toBe('true');
    // the Measurements group of that date opened too, the other date's stayed as it was
    expect(mrow('b')).not.toBeNull();
    expect(mrow('a')?.closest('[data-testid="date-folder-nov"]')).not.toBeNull();
    act(() => {
      root.unmount();
    });
  });
});
