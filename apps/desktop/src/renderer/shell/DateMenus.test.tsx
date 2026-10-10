// @vitest-environment jsdom
import type { Capture } from '@aio/schema';
import { EVERY_DATE, type DateFolder, type DateFolderMenuRequest } from '@aio/ui';
import { dateTags } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateFolderMenu, LayerDateMenu, type DateFolderMenuProps } from './DateMenus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const captures: Capture[] = [
  { id: 'sep', label: 'Survey', date: '2024-09-04' },
  { id: 'oct', label: 'Baseline', date: '2024-10-02', colour: 6, icon: 'flag' },
  { id: 'nov', label: '2024-11-06', date: '2024-11-06' },
];
const tags = dateTags(captures);
const folder = (id: string, layerIds: string[]): DateFolder => {
  const capture = captures.find((c) => c.id === id) ?? null;
  return { id, capture, label: capture ? capture.date : 'Every date', groups: [], layerIds };
};

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

describe('LayerDateMenu', () => {
  const open = (from: string) => {
    const onMove = vi.fn();
    const onClose = vi.fn();
    root = createRoot(host);
    act(() =>
      root?.render(
        <LayerDateMenu
          menu={{
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

  it('files the dataset under the picked date, or under none', () => {
    const { onMove, onClose } = open('oct');
    click('move-to-sep');
    expect(onMove).toHaveBeenLastCalledWith(['quad'], 'sep');
    click('move-to-every');
    expect(onMove).toHaveBeenLastCalledWith(['quad'], null);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
