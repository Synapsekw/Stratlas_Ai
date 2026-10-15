// @vitest-environment jsdom
import type { Capture } from '@aio/schema';
import { EVERY_DATE, type DateFolder, type DateFolderMenuRequest } from '@aio/ui';
import { dateTags, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareWith, COMPARE_WITH_ACTIONS } from '../workspace/compareWith';
import {
  DateFolderMenu,
  LayerDateMenu,
  type DateFolderMenuProps,
  type LayerDateMenuProps,
} from './DateMenus';

vi.mock('../workspace/compareWith', () => ({
  COMPARE_WITH_ACTIONS: [],
  compareWith: vi.fn(() => true),
  compareTargets: vi.fn((from: string) =>
    [
      { capture: 'nov', reason: null },
      { capture: 'oct', reason: null },
      { capture: 'sep', reason: 'compare.with.noRaster' },
    ].filter((x) => x.capture !== from),
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const captures: Capture[] = [
  { id: 'sep', label: 'Survey', date: '2024-09-04' },
  { id: 'oct', label: 'Baseline', date: '2024-10-02', colour: 6, icon: 'flag' },
  { id: 'nov', label: '2024-11-06', date: '2024-11-06' },
];
const tags = dateTags(captures);
const only = (i: number): Capture => {
  const c = captures[i];
  if (!c) throw new Error('no such capture');
  return c;
};
const folder = (id: string, layerIds: string[]): DateFolder => {
  const capture = captures.find((c) => c.id === id) ?? null;
  return { id, capture, label: capture ? capture.date : 'Every date', groups: [], layerIds };
};

let host: HTMLDivElement;
let root: Root | undefined;
const setProject = (list: Capture[]) => {
  workspace.setState({
    project: { id: 'p1', root: 'C:/p', manifest: { captures: list, layers: [] } },
  } as unknown as Partial<ReturnType<typeof workspace.getState>>);
};
beforeEach(() => {
  setProject(captures);
  vi.mocked(compareWith).mockClear();
  COMPARE_WITH_ACTIONS.length = 0;
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  workspace.setState({ project: null });
  host.remove();
});
// the menus render into the body (a portal), not into the host
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => {
  act(() => q(id)?.click());
};

function folderMenu(id: string, extra: Partial<DateFolderMenuProps> = {}) {
  const f = folder(id, id === 'nov' ? [] : ['a', 'b']);
  const menu: DateFolderMenuRequest = { folder: f, expanded: false, toggle: vi.fn(), x: 10, y: 10 };
  const props: DateFolderMenuProps = {
    menu,
    folder: f,
    tag: tags[id],
    focused: false,
    hidden: {},
    canEdit: true,
    onClose: vi.fn(),
    onFocus: vi.fn(),
    onSetVisible: vi.fn(),
    onRename: vi.fn(),
    onStyle: vi.fn(),
    ...extra,
  };
  root = createRoot(host);
  act(() => root?.render(<DateFolderMenu {...props} />));
  return props;
}

describe('DateFolderMenu', () => {
  it('views the date, opens the folder and shows or hides its layers', () => {
    const p = folderMenu('sep', { hidden: { a: true } });
    expect(q('date-menu')?.getAttribute('aria-label')).toBe('Survey date 2024-09-04');
    click('date-menu-view');
    expect(p.onFocus).toHaveBeenCalledWith('sep');
    click('date-menu-toggle');
    expect(p.menu.toggle).toHaveBeenCalledTimes(1);
    click('date-menu-show');
    expect(p.onSetVisible).toHaveBeenLastCalledWith(['a', 'b'], true);
    click('date-menu-hide');
    expect(p.onSetVisible).toHaveBeenLastCalledWith(['a', 'b'], false);
    expect(p.onClose).toHaveBeenCalledTimes(4);
  });

  it('greys what would change nothing', () => {
    folderMenu('sep', { focused: true, hidden: { a: true, b: true } });
    expect((q('date-menu-view') as HTMLButtonElement).disabled).toBe(true);
    expect((q('date-menu-hide') as HTMLButtonElement).disabled).toBe(true);
    expect((q('date-menu-show') as HTMLButtonElement).disabled).toBe(false);
  });

  it('has no show or hide for a date without layers', () => {
    folderMenu('nov');
    expect(q('date-menu-show')).toBeNull();
    expect(q('date-menu-hide')).toBeNull();
  });

  it('renames through the tree and closes', () => {
    const p = folderMenu('sep');
    click('date-menu-rename');
    expect(p.onRename).toHaveBeenCalledWith('sep');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('picks a colour or an icon and stays open for the next pick', () => {
    const p = folderMenu('sep');
    // September is the oldest date: colour 1 by its place in date order
    expect(q('date-menu-colour-1')?.getAttribute('aria-checked')).toBe('true');
    expect(q('date-menu-icon-none')?.getAttribute('aria-checked')).toBe('true');
    click('date-menu-colour-4');
    expect(p.onStyle).toHaveBeenLastCalledWith('sep', { colour: 4 });
    click('date-menu-icon-pin');
    expect(p.onStyle).toHaveBeenLastCalledWith('sep', { icon: 'pin' });
    expect(p.onClose).not.toHaveBeenCalled();
    // nothing picked yet: nothing to reset
    expect(q('date-menu-reset')).toBeNull();
  });

  it('marks the picked colour and icon, and resets both to the automatic ones', () => {
    const p = folderMenu('oct');
    expect(q('date-menu-colour-6')?.getAttribute('aria-checked')).toBe('true');
    expect(q('date-menu-icon-flag')?.getAttribute('aria-checked')).toBe('true');
    expect(q('date-menu-icon-none')?.getAttribute('aria-checked')).toBe('false');
    click('date-menu-icon-none');
    expect(p.onStyle).toHaveBeenLastCalledWith('oct', { icon: null });
    click('date-menu-reset');
    expect(p.onStyle).toHaveBeenLastCalledWith('oct', { colour: null, icon: null });
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('offers no rename, colour or icon in a read-only project', () => {
    folderMenu('oct', { canEdit: false });
    expect(q('date-menu-view')).not.toBeNull();
    expect(q('date-menu-rename')).toBeNull();
    expect(q('date-menu-colour-1')).toBeNull();
    expect(q('date-menu-icon-flag')).toBeNull();
    expect(q('date-menu-reset')).toBeNull();
  });

  it('Every date opens, closes, shows and hides, and is never renamed or coloured', () => {
    folderMenu(EVERY_DATE);
    expect(q('date-menu-toggle')).not.toBeNull();
    expect(q('date-menu-show')).not.toBeNull();
    expect(q('date-menu-view')).toBeNull();
    expect(q('date-menu-rename')).toBeNull();
    expect(q('date-menu-colour-1')).toBeNull();
  });

  it('closes on a press outside and on Escape', () => {
    const p = folderMenu('sep');
    act(() => {
      q('date-menu')?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(p.onClose).not.toHaveBeenCalled();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    act(() => {
      q('date-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });
});

describe('DateFolderMenu: Compare with', () => {
  it('lists the other dates newest first, with swatches, and compares with the picked one', () => {
    const p = folderMenu('nov');
    click('date-menu-compare');
    expect(q('date-menu')?.textContent).toContain('Compare 6 Nov 2024 with');
    const ids = [...document.body.querySelectorAll('[data-testid^="compare-to-"]')].map((b) =>
      b.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['compare-to-oct', 'compare-to-sep']);
    expect(q('compare-to-oct')?.textContent).toContain('2 Oct 2024');
    expect(q('compare-to-oct')?.querySelector('.sw')).not.toBeNull();
    click('compare-to-oct');
    expect(compareWith).toHaveBeenCalledWith({ from: 'nov', to: 'oct' });
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows why a date is off and does not compare with it', () => {
    folderMenu('nov');
    click('date-menu-compare');
    const sep = q('compare-to-sep') as HTMLButtonElement;
    expect(sep.disabled).toBe(true);
    expect(sep.textContent).toContain('No ortho');
    click('compare-to-sep');
    expect(compareWith).not.toHaveBeenCalled();
  });

  it('goes back to the menu, and Escape closes', () => {
    const p = folderMenu('nov');
    click('date-menu-compare');
    expect(q('date-menu-toggle')).toBeNull();
    click('compare-back');
    expect(q('date-menu-toggle')).not.toBeNull();
    expect(p.onClose).not.toHaveBeenCalled();
    click('date-menu-compare');
    act(() => {
      q('date-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps focus inside the menu after the view changes', () => {
    folderMenu('nov');
    click('date-menu-compare');
    expect(q('date-menu')?.contains(document.activeElement)).toBe(true);
  });

  it('is offered in a read-only project, but not with one survey date or for Every date', () => {
    folderMenu('nov', { canEdit: false });
    expect(q('date-menu-compare')).not.toBeNull();
    act(() => root?.unmount());
    folderMenu(EVERY_DATE);
    expect(q('date-menu-compare')).toBeNull();
    act(() => root?.unmount());
    setProject([only(2)]);
    folderMenu('nov');
    expect(q('date-menu-compare')).toBeNull();
  });

  it('renders extra actions under each enabled date with the request and close', () => {
    const seen: unknown[] = [];
    COMPARE_WITH_ACTIONS.push((p) => {
      seen.push(p.request);
      return (
        <button key={p.request.to} type="button" data-testid={`extra-${p.request.to}`}>
          Extra
        </button>
      );
    });
    folderMenu('nov');
    click('date-menu-compare');
    expect(q('extra-oct')).not.toBeNull();
    expect(q('extra-sep')).toBeNull();
    expect(seen).toContainEqual({ from: 'nov', to: 'oct', layers: undefined });
  });
});

describe('LayerDateMenu', () => {
  const open = (from: string, canEdit = true, extra: Partial<LayerDateMenuProps> = {}) => {
    const onMove = vi.fn();
    const onClose = vi.fn();
    root = createRoot(host);
    act(() =>
      root?.render(
        <LayerDateMenu
          menu={{
            name: 'Quad',
            item: { id: 'quad', layerId: 'quad', layerKind: 'mesh', name: 'Quad' },
            layerIds: ['quad'],
            from,
            x: 5,
            y: 5,
          }}
          captures={captures}
          tags={tags}
          every={EVERY_DATE}
          onClose={onClose}
          onMove={onMove}
          canEdit={canEdit}
          {...extra}
        />,
      ),
    );
    return { onMove, onClose };
  };

  it('lists Every date and the dates newest first, the current one marked and off', () => {
    open('oct');
    const ids = [...document.body.querySelectorAll('[data-testid^="move-to-"]')].map((b) =>
      b.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['move-to-every', 'move-to-nov', 'move-to-oct', 'move-to-sep']);
    expect((q('move-to-oct') as HTMLButtonElement).disabled).toBe(true);
    expect(q('move-to-oct')?.getAttribute('aria-checked')).toBe('true');
    // a name beside the date, unless the label only repeats the date
    expect(q('move-to-oct')?.textContent).toContain('Baseline');
    expect(q('move-to-nov')?.textContent).not.toContain('2024-11-06');
  });

  it('lists the layer actions first and runs them, closing the menu', () => {
    const run = vi.fn();
    const { onClose } = open('oct', true, {
      actions: [
        { id: 'pointcloud.cleanup', label: 'Clean up...', testId: 'menu-pointcloud-cleanup', run },
        {
          id: 'pointcloud.resetCleanup',
          label: 'Reset cleanup',
          testId: 'menu-pointcloud-resetCleanup',
          run,
        },
      ],
    });
    const items = [...document.body.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')];
    expect(items[0]?.getAttribute('data-testid')).toBe('menu-pointcloud-cleanup');
    click('menu-pointcloud-cleanup');
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens for actions alone in a read-only project', () => {
    open('oct', false, {
      actions: [
        {
          id: 'pointcloud.cleanup',
          label: 'Clean up...',
          testId: 'menu-pointcloud-cleanup',
          run: vi.fn(),
        },
      ],
      dateMoves: false,
    });
    expect(q('menu-pointcloud-cleanup')).not.toBeNull();
  });

  it('files the dataset under the picked date, or under none', () => {
    const { onMove, onClose } = open('oct');
    click('move-to-sep');
    expect(onMove).toHaveBeenLastCalledWith(['quad'], 'sep');
    click('move-to-every');
    expect(onMove).toHaveBeenLastCalledWith(['quad'], null);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('heads the menu of a group with the group and how many datasets it moves', () => {
    const onMove = vi.fn();
    root = createRoot(host);
    act(() =>
      root?.render(
        <LayerDateMenu
          menu={{ name: 'Video · 12 datasets', layerIds: ['a', 'b'], from: 'nov', x: 5, y: 5 }}
          captures={captures}
          tags={tags}
          every={EVERY_DATE}
          onClose={vi.fn()}
          onMove={onMove}
          canEdit
        />,
      ),
    );
    const menu = document.body.querySelector('[data-testid="move-menu"]');
    expect(menu?.textContent).toContain('Move to date · Video · 12 datasets');
    expect(menu?.getAttribute('aria-label')).toBe('Move Video · 12 datasets to a survey date');
    act(() => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="move-to-oct"]')?.click();
    });
    expect(onMove).toHaveBeenCalledWith(['a', 'b'], 'oct');
  });

  it('offers Compare with another date, and File under only when the project can be edited', () => {
    open('oct', false);
    expect(q('move-compare')?.textContent).toContain('Compare with another date...');
    expect(q('move-to-sep')).toBeNull();
    expect(q('move-to-every')).toBeNull();
    act(() => root?.unmount());
    open('oct', true);
    expect(q('move-compare')).not.toBeNull();
    expect(q('move-to-sep')).not.toBeNull();
    expect(document.body.textContent).toContain('File under');
  });

  it('compares the layers with the picked date', () => {
    const { onClose } = open('oct');
    click('move-compare');
    expect(q('move-menu')?.textContent).toContain('Compare 2 Oct 2024 with');
    click('compare-to-nov');
    expect(compareWith).toHaveBeenCalledWith({ from: 'oct', to: 'nov', layers: ['quad'] });
    expect(onClose).toHaveBeenCalledTimes(1);
    click('compare-back');
  });

  it('has no compare item with one survey date or for a layer in Every date', () => {
    open(EVERY_DATE);
    expect(q('move-compare')).toBeNull();
    act(() => root?.unmount());
    setProject([only(1)]);
    open('oct');
    expect(q('move-compare')).toBeNull();
  });

  it('opens no empty menu in a read-only project with nothing to compare', () => {
    const { onClose } = open(EVERY_DATE, false);
    expect(q('move-menu')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape, and Back returns to the menu', () => {
    const { onClose } = open('oct');
    click('move-compare');
    click('compare-back');
    expect(q('move-compare')).not.toBeNull();
    act(() => {
      q('move-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers Delete… that hands over its layers', () => {
    const onDelete = vi.fn();
    const { onClose } = open('oct', true, { onDelete });
    click('menu-delete');
    expect(onDelete).toHaveBeenCalledWith(['quad']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no Delete… in a read-only project, though the menu opens to compare', () => {
    open('oct', false, { onDelete: vi.fn() });
    expect(q('move-compare')).not.toBeNull();
    expect(q('menu-delete')).toBeNull();
  });

  it('has no Delete… without the callback (rows that cannot be deleted)', () => {
    open('oct');
    expect(q('menu-delete')).toBeNull();
  });

  it('with dates off has no File under list, only Compare and Delete', () => {
    open('oct', true, { onDelete: vi.fn(), dateMoves: false });
    expect(document.body.querySelector('[data-testid^="move-to-"]')).toBeNull();
    expect(document.body.textContent).not.toContain('File under');
    expect(q('move-compare')).not.toBeNull();
    expect(q('menu-delete')).not.toBeNull();
  });

  it('with dates off opens no empty menu on a row it cannot compare or delete', () => {
    const { onClose } = open(EVERY_DATE, true, { dateMoves: false });
    expect(q('move-menu')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('DateFolderMenu: Delete…', () => {
  it('a date folder offers Delete… for its date', () => {
    const onDelete = vi.fn();
    const p = folderMenu('sep', { onDelete });
    click('date-menu-delete');
    expect(onDelete).toHaveBeenCalledWith('sep');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('Every date and a read-only project have no Delete… on the folder', () => {
    folderMenu(EVERY_DATE, { onDelete: vi.fn() });
    expect(q('date-menu-delete')).toBeNull();
    act(() => root?.unmount());
    folderMenu('sep', { canEdit: false, onDelete: vi.fn() });
    expect(q('date-menu-view')).not.toBeNull();
    expect(q('date-menu-delete')).toBeNull();
  });
});
