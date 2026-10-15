// @vitest-environment jsdom
import type { LibraryEntry, LibraryFolder } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../shell';
import { DRAG_TYPE } from './libraryFolderModel';
import { FolderBack, FolderRow, NewFolderButton } from './LibraryFolders';
import { MoveToFolderDialog } from './MoveToFolderDialog';

/** The value, or a failed test when it is missing. */
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('missing in the test page');
  return v;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SURVEYS: LibraryFolder = { id: 'f_aaaaaaaaaa', name: 'Surveys' };
const OLD: LibraryFolder = { id: 'f_bbbbbbbbbb', name: 'Old' };
const yard: LibraryEntry = {
  id: 'north-yard',
  name: 'North yard',
  path: 'D:\\data\\projects\\north-yard',
  kind: 'native',
  folderId: SURVEYS.id,
};

const original = shell.getState();
const actions = {
  createFolder: vi.fn<(n: string) => Promise<string | null>>(() => Promise.resolve(null)),
  renameFolder: vi.fn<(id: string, n: string) => Promise<string | null>>(() =>
    Promise.resolve(null),
  ),
  deleteFolder: vi.fn<(id: string) => Promise<string | null>>(() => Promise.resolve(null)),
  moveToFolder: vi.fn<(e: LibraryEntry, id: string | null) => Promise<string | null>>(() =>
    Promise.resolve(null),
  ),
};

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockClear();
  shell.setState({ ...actions, folders: [SURVEYS, OLD], library: [yard] });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  shell.setState(original, true);
});

const render = (node: React.ReactNode) => {
  root = createRoot(host);
  act(() => root?.render(node));
};
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const settle = async (fn: () => void) => {
  await act(async () => {
    fn();
    await Promise.resolve();
  });
};
const typeInto = (el: HTMLInputElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** A drag event as the browser sends it; jsdom has no DataTransfer of its own. */
function drag(on: Element, type: string, types: string[] = [DRAG_TYPE], id = 'north-yard') {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { types, getData: (k: string) => (k === DRAG_TYPE ? id : ''), dropEffect: 'none' },
  });
  act(() => {
    on.dispatchEvent(ev);
  });
  return ev;
}

function row(onOpen = vi.fn(), onCard = vi.fn(), dragging = false) {
  render(
    <FolderRow
      folders={[SURVEYS, OLD]}
      counts={new Map([[SURVEYS.id, 2]])}
      dragging={dragging}
      onOpen={onOpen}
      onCard={onCard}
    />,
  );
  return { onOpen, onCard };
}

describe('FolderRow', () => {
  it('shows one tile per folder with its count, and opens one on click or Enter', () => {
    const { onOpen } = row();
    const tiles = all('folder-tile');
    expect(tiles.map((t) => t.textContent)).toEqual(['Surveys2', 'Old0']);
    act(() => tiles[0]?.click());
    expect(onOpen).toHaveBeenLastCalledWith(SURVEYS.id);
    act(() => {
      tiles[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onOpen).toHaveBeenLastCalledWith(OLD.id);
  });

  it('shows nothing without folders', () => {
    render(
      <FolderRow
        folders={[]}
        counts={new Map()}
        dragging={false}
        onOpen={vi.fn()}
        onCard={vi.fn()}
      />,
    );
    expect(q('folder-row')).toBeNull();
  });

  it('lights a tile while a card hovers it and moves the card dropped on it', () => {
    const { onCard } = row();
    const tile = must(all('folder-tile')[1]);
    const over = drag(tile, 'dragenter');
    expect(over.defaultPrevented).toBe(true);
    expect(tile.classList.contains('over')).toBe(true);
    drag(tile, 'dragleave');
    expect(tile.classList.contains('over')).toBe(false);
    drag(tile, 'dragover');
    drag(tile, 'drop');
    expect(onCard).toHaveBeenCalledWith('north-yard', OLD.id);
    expect(tile.classList.contains('over')).toBe(false);
  });

  it('ignores a drag that is not a project card', () => {
    const { onCard } = row();
    const tile = must(all('folder-tile')[0]);
    const ev = drag(tile, 'dragover', ['Files']);
    expect(ev.defaultPrevented).toBe(false);
    expect(tile.classList.contains('over')).toBe(false);
    drag(tile, 'drop', ['Files']);
    expect(onCard).not.toHaveBeenCalled();
  });

  it('renames a folder from its right-click menu', async () => {
    row();
    const tile = must(all('folder-tile')[0]);
    act(() => {
      tile.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 30,
        }),
      );
    });
    expect(q('folder-menu')).not.toBeNull();
    act(() => q('folder-menu-rename')?.click());
    expect(q('folder-menu')).toBeNull();
    const field = must(q('folder-name')) as HTMLInputElement;
    expect(field.value).toBe('Surveys');
    typeInto(field, '  Site surveys ');
    await settle(() => q('folder-name-confirm')?.click());
    expect(actions.renameFolder).toHaveBeenCalledWith(SURVEYS.id, 'Site surveys');
    expect(q('folder-rename-dialog')).toBeNull();
  });

  it('deletes a folder after asking, and keeps the dialog with the reason when it fails', async () => {
    actions.deleteFolder.mockResolvedValueOnce('The library could not be saved.');
    row();
    act(() => {
      all('folder-tile')[1]?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    act(() => q('folder-menu-delete')?.click());
    expect(q('folder-delete-dialog')?.textContent).toContain(
      'The projects in Old stay in the library without a folder.',
    );
    await settle(() => q('folder-delete-confirm')?.click());
    expect(actions.deleteFolder).toHaveBeenCalledWith(OLD.id);
    expect(q('folder-delete-dialog')?.textContent).toContain('The library could not be saved.');
    await settle(() => q('folder-delete-confirm')?.click());
    expect(q('folder-delete-dialog')).toBeNull();
  });
});

describe('NewFolderButton', () => {
  it('makes a folder with the name typed', async () => {
    render(<NewFolderButton />);
    act(() => q('library-new-folder')?.click());
    const confirm = must(q('folder-name-confirm')) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    typeInto(must(q('folder-name')) as HTMLInputElement, 'Bridges');
    await settle(() => {
      confirm.click();
    });
    expect(actions.createFolder).toHaveBeenCalledWith('Bridges');
    expect(q('folder-new-dialog')).toBeNull();
  });
});

describe('FolderBack', () => {
  it('goes back to All and takes a dropped card out of the folder', () => {
    const onBack = vi.fn();
    const onCard = vi.fn();
    render(<FolderBack dragging onBack={onBack} onCard={onCard} />);
    const back = must(q('folder-back'));
    expect(back.textContent).toBe('All projects');
    act(() => {
      back.click();
    });
    expect(onBack).toHaveBeenCalled();
    drag(back, 'dragenter');
    expect(back.classList.contains('over')).toBe(true);
    drag(back, 'drop');
    expect(onCard).toHaveBeenCalledWith('north-yard');
  });
});

describe('MoveToFolderDialog', () => {
  const open = (entry: LibraryEntry = yard) => {
    const onClose = vi.fn();
    render(
      <MoveToFolderDialog entry={entry} current={false} onClose={onClose} returnTo={() => null} />,
    );
    return onClose;
  };
  const radios = () => all('move-folder-option').map((l) => must(l.querySelector('input')));

  it('lists No folder and every folder, the card’s own one checked', () => {
    open();
    expect(q('move-folder-dialog')?.textContent).toContain('Move North yard to a folder');
    expect(all('move-folder-option').map((l) => l.textContent)).toEqual([
      'No folder',
      'Surveys1',
      'Old0',
    ]);
    expect(radios().map((r) => r.checked)).toEqual([false, true, false]);
  });

  it('moves the card to the folder picked, or to none', async () => {
    const onClose = open();
    act(() => radios()[2]?.click());
    await settle(() => q('move-folder-confirm')?.click());
    expect(actions.moveToFolder).toHaveBeenLastCalledWith(yard, OLD.id);
    expect(onClose).toHaveBeenCalled();
    act(() => {
      root?.unmount();
    });
    open();
    act(() => radios()[0]?.click());
    await settle(() => q('move-folder-confirm')?.click());
    expect(actions.moveToFolder).toHaveBeenLastCalledWith(yard, null);
  });

  it('closes without a call when the choice is unchanged', async () => {
    const onClose = open({ id: 'quarry', name: 'Quarry', path: 'D:\\q', kind: 'native' });
    expect(radios()[0]?.checked).toBe(true);
    await settle(() => q('move-folder-confirm')?.click());
    expect(actions.moveToFolder).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
