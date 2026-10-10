// @vitest-environment jsdom
import type { LibraryEntry } from '@aio/schema';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../shell';
import { ProjectMenu, type MenuAt } from './ProjectMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = 'D:\\Survey Data';
const yard: LibraryEntry = {
  id: 'north-yard',
  name: 'North yard',
  path: `${DATA}\\projects\\north-yard`,
  kind: 'native',
  sizeBytes: 2048,
};
const pkg: LibraryEntry = {
  id: 'handover',
  name: 'Handover',
  path: `${DATA}\\projects\\handover.aio`,
  kind: 'native',
  package: { encrypted: false, readOnly: true },
};

const original = shell.getState();
const actions = {
  openProject: vi.fn(() => Promise.resolve()),
  revealProject: vi.fn(() => Promise.resolve<string | null>(null)),
  renameProject: vi.fn(() => Promise.resolve<string | null>(null)),
  deleteProject: vi.fn(() => Promise.resolve<string | null>(null)),
  closeProject: vi.fn(),
};

let host: HTMLDivElement;
let root: Root | undefined;
const cardClicks = vi.fn();

function Card({ entry, current = false }: { entry: LibraryEntry; current?: boolean }) {
  const [at, setAt] = useState<MenuAt | null>(null);
  return (
    // a parent that listens for clicks, as the card itself does
    <div onClick={cardClicks}>
      <ProjectMenu entry={entry} current={current} opening={false} at={at} onAt={setAt} />
    </div>
  );
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockClear();
  actions.renameProject.mockResolvedValue(null);
  actions.deleteProject.mockResolvedValue(null);
  cardClicks.mockClear();
  shell.setState({ ...actions, settings: { ...original.settings, dataRoot: DATA } });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  shell.setState(original, true);
});

const render = (entry: LibraryEntry = yard, current = false) => {
  root = createRoot(host);
  act(() => root?.render(<Card entry={entry} current={current} />));
};
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const input = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
const dots = () => button('project-menu-button');
const item = (id: string) => button(`project-menu-${id}`);
const click = (el: HTMLElement | null) => {
  act(() => el?.click());
};
/** Click and let the answer of the (mocked) call come back. */
const clickAndSettle = async (el: HTMLElement | null) => {
  await act(async () => {
    el?.click();
    await Promise.resolve();
  });
};
const key = (k: string, on: Element | null = document.activeElement) => {
  act(() => {
    on?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
};
const typeInto = (el: HTMLInputElement | null, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el?.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('the three dots of a project card', () => {
  it('is a button named after the project that announces a menu', () => {
    render();
    const b = dots();
    expect(b?.tagName).toBe('BUTTON');
    expect(b?.getAttribute('type')).toBe('button');
    expect(b?.getAttribute('aria-label')).toBe('Actions for North yard');
    expect(b?.getAttribute('aria-haspopup')).toBe('menu');
    expect(b?.getAttribute('aria-expanded')).toBe('false');
    expect(q('project-menu')).toBeNull();
  });

  it('opens the menu without the click reaching the card', () => {
    render();
    click(dots());
    expect(cardClicks).not.toHaveBeenCalled();
    expect(dots()?.getAttribute('aria-expanded')).toBe('true');
    const menu = q('project-menu');
    expect(menu?.getAttribute('role')).toBe('menu');
    expect(menu?.getAttribute('aria-label')).toBe('Project North yard');
    expect(
      [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map((i) => i.textContent),
    ).toEqual(['Open', 'Rename', 'Show in folder', 'Delete']);
    // a second click on the dots closes it again
    click(dots());
    expect(q('project-menu')).toBeNull();
  });

  it('works from the keyboard: arrows move, Escape closes and focus goes back to the dots', async () => {
    render();
    dots()?.focus();
    key('ArrowDown');
    expect(q('project-menu')).not.toBeNull();
    expect(document.activeElement).toBe(item('open'));
    key('ArrowDown');
    expect(document.activeElement).toBe(item('rename'));
    key('End');
    expect(document.activeElement).toBe(item('delete'));
    key('ArrowDown');
    expect(document.activeElement).toBe(item('open'));
    key('ArrowUp');
    expect(document.activeElement).toBe(item('delete'));
    key('Escape');
    expect(q('project-menu')).toBeNull();
    await settle();
    expect(document.activeElement).toBe(dots());
    expect(cardClicks).not.toHaveBeenCalled();
  });

  it('closes on a press anywhere else', () => {
    render();
    click(dots());
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(q('project-menu')).toBeNull();
  });

  /** The dots at `top` on screen, as the browser would report them. */
  const dotsAt = (top: number) => {
    const b = dots();
    if (b) b.getBoundingClientRect = () => new DOMRect(700, top, 26, 26);
  };
  const scroll = () => {
    act(() => {
      document.body.dispatchEvent(new Event('scroll'));
    });
  };

  it('stays open when a scroll is reported but the card has not moved since it opened', () => {
    // a scroll that brought the card into view just before the click is reported a frame later
    render();
    dotsAt(180);
    click(dots());
    scroll();
    expect(q('project-menu')).not.toBeNull();
  });

  it('closes when the list scrolls and the card moves away', () => {
    render();
    dotsAt(180);
    click(dots());
    dotsAt(60);
    scroll();
    expect(q('project-menu')).toBeNull();
  });

  it('opens the project and shows its folder', () => {
    render();
    click(dots());
    click(item('open'));
    expect(actions.openProject).toHaveBeenCalledWith(yard.path);
    expect(q('project-menu')).toBeNull();
    click(dots());
    click(item('reveal'));
    expect(actions.revealProject).toHaveBeenCalledWith(yard);
  });

  it('offers Export package and Close project on the open project and holds Delete back', () => {
    render(yard, true);
    click(dots());
    expect(item('export')).not.toBeNull();
    click(item('close'));
    expect(actions.closeProject).toHaveBeenCalled();
    click(dots());
    expect(item('delete')?.getAttribute('aria-disabled')).toBe('true');
    expect(item('delete')?.textContent).toContain('Close the project first');
    click(item('delete'));
    expect(q('project-delete')).toBeNull();
  });

  it('greys Rename and Delete for a package and says why', () => {
    render(pkg);
    click(dots());
    for (const id of ['rename', 'delete']) {
      expect(item(id)?.getAttribute('aria-disabled')).toBe('true');
      expect(item(id)?.textContent).toContain('A package is a read-only file');
      click(item(id));
    }
    // nothing ran, and the menu is still there to read
    expect(q('project-menu')).not.toBeNull();
    expect(q('project-rename')).toBeNull();
    expect(q('project-delete')).toBeNull();
    expect(item('open')?.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('renaming from the menu', () => {
  const openRename = () => {
    render();
    click(dots());
    click(item('rename'));
  };

  it('asks for the name in a dialog that starts with the current one', () => {
    openRename();
    const dlg = q('project-rename');
    expect(dlg?.getAttribute('role')).toBe('dialog');
    expect(dlg?.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dlg?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Rename project',
    );
    expect(input('project-rename-name')?.value).toBe('North yard');
    // it says what stays: the folder on disk
    expect(dlg?.textContent).toContain('The folder on disk keeps its name: north-yard');
  });

  it('renames with the trimmed name and closes', async () => {
    openRename();
    typeInto(input('project-rename-name'), '  West yard ');
    await clickAndSettle(q('project-rename-confirm'));
    expect(actions.renameProject).toHaveBeenCalledWith(yard, 'West yard');
    expect(q('project-rename')).toBeNull();
  });

  it('does not rename to nothing, and an unchanged name just closes', async () => {
    openRename();
    typeInto(input('project-rename-name'), '   ');
    expect(button('project-rename-confirm')?.disabled).toBe(true);
    typeInto(input('project-rename-name'), 'North yard');
    await clickAndSettle(q('project-rename-confirm'));
    expect(actions.renameProject).not.toHaveBeenCalled();
    expect(q('project-rename')).toBeNull();
  });

  it('shows why it did not work and stays open', async () => {
    actions.renameProject.mockResolvedValue('manifest.json could not be saved.');
    openRename();
    typeInto(input('project-rename-name'), 'West yard');
    await clickAndSettle(q('project-rename-confirm'));
    const alert = q('project-rename')?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('The project was not renamed.');
    expect(alert?.textContent).toContain('manifest.json could not be saved.');
    expect(button('project-rename-confirm')?.disabled).toBe(false);
  });

  it('Escape cancels', () => {
    openRename();
    key('Escape', q('project-rename-name'));
    expect(q('project-rename')).toBeNull();
    expect(actions.renameProject).not.toHaveBeenCalled();
  });
});

describe('deleting from the menu', () => {
  const openDelete = () => {
    render();
    click(dots());
    click(item('delete'));
  };

  it('asks first, naming the project and saying what happens', () => {
    openDelete();
    const dlg = q('project-delete');
    expect(dlg?.getAttribute('role')).toBe('alertdialog');
    expect(document.getElementById(dlg?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Delete North yard?',
    );
    const text = document.getElementById(dlg?.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(text).toContain('moves to the recycle bin');
    expect(dlg?.textContent).toContain(yard.path);
    expect(dlg?.textContent).toContain('restore the folder from the recycle bin');
    expect(q('project-delete-confirm')?.textContent).toBe('Move to recycle bin');
    // nothing happened yet, and the safe button has focus
    expect(actions.deleteProject).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(q('project-delete-cancel'));
  });

  it('Cancel and Escape delete nothing', () => {
    openDelete();
    click(q('project-delete-cancel'));
    expect(q('project-delete')).toBeNull();
    click(dots());
    click(item('delete'));
    key('Escape');
    expect(q('project-delete')).toBeNull();
    expect(actions.deleteProject).not.toHaveBeenCalled();
  });

  it('deletes after the confirmation and closes', async () => {
    openDelete();
    await clickAndSettle(q('project-delete-confirm'));
    expect(actions.deleteProject).toHaveBeenCalledWith(yard);
    expect(q('project-delete')).toBeNull();
  });

  it('shows the error and stays when the recycle bin refused', async () => {
    actions.deleteProject.mockResolvedValue('The item is in use.');
    openDelete();
    await clickAndSettle(q('project-delete-confirm'));
    const alert = q('project-delete')?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'The project was not deleted. It is still in the library.',
    );
    expect(alert?.textContent).toContain('The item is in use.');
    expect(button('project-delete-confirm')?.disabled).toBe(false);
  });
});
