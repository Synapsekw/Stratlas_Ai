// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DateTag } from '@aio/workspace';
import { DateTree, type DateTreeProps } from './DateTree';
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
      expect.objectContaining({ layerIds: ['m-nov'], from: 'nov', x: 12, y: 34 }),
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
