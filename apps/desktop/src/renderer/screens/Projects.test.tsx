// @vitest-environment jsdom
import type { LibraryEntry, LibraryFolder } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../shell';
import { DRAG_TYPE } from './libraryFolderModel';
import { ProjectsScreen } from './Projects';

/** The value, or a failed test when it is missing. */
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('missing in the test page');
  return v;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SURVEYS: LibraryFolder = { id: 'f_aaaaaaaaaa', name: 'Surveys' };
const entry = (id: string, more: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id,
  name: id,
  path: `D:\\data\\projects\\${id}`,
  kind: 'native',
  ...more,
});
const library = [
  entry('north-yard'),
  entry('quarry', { folderId: SURVEYS.id }),
  entry('bridge', { folderId: SURVEYS.id }),
];

const original = shell.getState();
const actions = {
  loadLibrary: vi.fn(() => Promise.resolve()),
  moveToFolder: vi.fn<(e: LibraryEntry, id: string | null) => Promise<string | null>>(() =>
    Promise.resolve(null),
  ),
  dismissLibraryNotice: vi.fn(),
};

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockClear();
  shell.setState({ ...actions, library, folders: [SURVEYS], libraryNotice: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<ProjectsScreen />));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  shell.setState(original, true);
});

const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const names = () => all('project-card').map((c) => c.querySelector('.pc-name')?.textContent);
const search = (value: string) => {
  const el = must(document.querySelector<HTMLInputElement>('.lib-filter'));
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
function drag(on: Element, type: string, data: Record<string, string> = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', {
    value: {
      types: Object.keys(data),
      setData: (k: string, v: string) => {
        data[k] = v;
      },
      getData: (k: string) => data[k] ?? '',
      effectAllowed: 'all',
      dropEffect: 'none',
    },
  });
  act(() => {
    on.dispatchEvent(ev);
  });
}

describe('ProjectsScreen folders', () => {
  it('shows the loose cards and a tile per folder on All, the whole library in the count', () => {
    expect(names()).toEqual(['north-yard']);
    expect(all('folder-tile').map((t) => t.textContent)).toEqual(['Surveys2']);
    expect(document.querySelector('.home-h p')?.textContent).toBe('3 projects');
  });

  it('opens a folder, then goes back to All', () => {
    act(() => all('folder-tile')[0]?.click());
    expect(q('library-place')?.textContent).toBe('Surveys');
    expect(names()).toEqual(['bridge', 'quarry']);
    expect(q('folder-row')).toBeNull();
    act(() => q('folder-back')?.click());
    expect(q('library-place')?.textContent).toBe('Project library');
    expect(names()).toEqual(['north-yard']);
  });

  it('falls back to All when the open folder is deleted', () => {
    act(() => all('folder-tile')[0]?.click());
    act(() => {
      shell.setState({
        folders: [],
        library: library.map((e) => ({ id: e.id, name: e.name, path: e.path, kind: e.kind })),
      });
    });
    expect(q('folder-back')).toBeNull();
    expect(names()).toHaveLength(3);
  });

  it('shows the empty folder text in a folder with no cards', () => {
    act(() => {
      shell.setState({ folders: [SURVEYS, { id: 'f_bbbbbbbbbb', name: 'Empty' }] });
    });
    act(() => all('folder-tile')[1]?.click());
    expect(q('folder-empty')?.textContent).toContain('No projects in this folder yet.');
  });

  it('searches every folder and names each card’s folder', () => {
    search('r');
    expect(names()).toEqual(['bridge', 'north-yard', 'quarry']);
    expect(q('folder-row')).toBeNull();
    expect(all('card-folder').map((c) => c.textContent)).toEqual(['Surveys', 'Surveys']);
  });

  it('moves a card dropped on a tile into that folder, and one dropped on the back link out', () => {
    const card = must(document.querySelector('.pcard-wrap'));
    const data: Record<string, string> = {};
    drag(card, 'dragstart', data);
    expect(data[DRAG_TYPE]).toBe('north-yard');
    expect(q('folder-row')?.classList.contains('dragging')).toBe(true);
    drag(must(all('folder-tile')[0]), 'drop', data);
    drag(card, 'dragend', data);
    expect(actions.moveToFolder).toHaveBeenCalledWith(library[0], SURVEYS.id);
    expect(q('folder-row')?.classList.contains('dragging')).toBe(false);

    act(() => all('folder-tile')[0]?.click());
    drag(must(q('folder-back')), 'drop', { [DRAG_TYPE]: 'quarry' });
    expect(actions.moveToFolder).toHaveBeenLastCalledWith(library[1], null);
    // a drop where the card already is does nothing
    drag(must(q('folder-back')), 'drop', { [DRAG_TYPE]: 'north-yard' });
    expect(actions.moveToFolder).toHaveBeenCalledTimes(2);
  });

  it('shows the library notice with Dismiss', () => {
    act(() => {
      shell.setState({ libraryNotice: 'Quarry was removed from the library.' });
    });
    const notice = must(q('library-notice'));
    expect(notice.textContent).toContain('Quarry was removed from the library.');
    act(() => {
      notice.querySelector('button')?.click();
    });
    expect(actions.dismissLibraryNotice).toHaveBeenCalled();
  });
});
