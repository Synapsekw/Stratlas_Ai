// @vitest-environment jsdom
import type { GlobeSite } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filterSites, GlobeSearch } from './GlobeSearch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const site = (projectId: string, name: string, open = 0, date?: string): GlobeSite => ({
  projectId,
  name,
  lonLat: [10, 50],
  captures: date ? [{ id: `${projectId}-c`, label: 'Survey', date }] : [],
  issues: { open, bySeverity: {} },
  tilesets: [],
});

const SITES = [
  site('quarry', 'Hill quarry', 2, '2026-09-30'),
  site('yard', 'Harbour yard'),
  site('depot', 'North depot', 0, '2026-08-01'),
];

let host: HTMLDivElement;
let root: Root | undefined;
const scrolled = vi.fn();
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  // jsdom has no layout, so no scrolling: record which option was asked to come into view
  Element.prototype.scrollIntoView = scrolled;
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  scrolled.mockClear();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const field = () => host.querySelector<HTMLInputElement>('input[role="combobox"]');
const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
const names = () => options().map((o) => o.querySelector('.name')?.textContent);

function mount(sites: readonly GlobeSite[] = SITES, selected: string | null = null) {
  const onPick = vi.fn();
  const onLight = vi.fn();
  root = createRoot(host);
  act(() =>
    root?.render(<GlobeSearch sites={sites} selected={selected} {...{ onPick, onLight }} />),
  );
  return { onPick, onLight };
}
const focusField = () => {
  act(() => field()?.focus());
};
const typeInto = (value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field(), value);
    field()?.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const press = (key: string) => {
  act(() => {
    field()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};

describe('filterSites', () => {
  it('matches a name anywhere in it, ignoring case and surrounding spaces, in the given order', () => {
    expect(filterSites(SITES, '  AR ').map((s) => s.name)).toEqual(['Hill quarry', 'Harbour yard']);
    expect(filterSites(SITES, 'depot').map((s) => s.name)).toEqual(['North depot']);
  });

  it('keeps every site for an empty or blank query and none for a stranger', () => {
    expect(filterSites(SITES, '')).toEqual(SITES);
    expect(filterSites(SITES, '   ')).toEqual(SITES);
    expect(filterSites(SITES, 'zzz')).toEqual([]);
  });
});

describe('the Globe search field', () => {
  it('is a labelled combobox that starts closed', () => {
    mount();
    const input = field();
    expect(input?.getAttribute('aria-label')).toBe('Find a site');
    expect(input?.getAttribute('placeholder')).toBe('Find a site');
    expect(input?.getAttribute('aria-expanded')).toBe('false');
    expect(input?.getAttribute('aria-activedescendant')).toBeNull();
    expect(options()).toHaveLength(0);
  });

  it('lists every site when it gets focus, with its facts', () => {
    mount();
    focusField();
    const list = q('globe-sites');
    expect(list?.getAttribute('role')).toBe('listbox');
    expect(list?.getAttribute('aria-label')).toBe('Sites on the globe');
    expect(field()?.getAttribute('aria-expanded')).toBe('true');
    expect(field()?.getAttribute('aria-controls')).toBe(list?.id);
    expect(names()).toEqual(['Hill quarry', 'Harbour yard', 'North depot']);
    const first = options()[0];
    expect(first?.textContent).toContain('2026-09-30');
    expect(first?.textContent).toContain('2 open issues');
    expect(options()[1]?.textContent).toContain('No capture');
    expect(first?.getAttribute('data-tone')).toBe('attention');
    expect(options()[2]?.getAttribute('data-tone')).toBe('clear');
  });

  it('lists every site on a click in the field, too', () => {
    mount();
    act(() => field()?.click());
    expect(options()).toHaveLength(3);
  });

  it('narrows the list as the person types, and shows all again when it is cleared', () => {
    mount();
    focusField();
    typeInto('har');
    expect(names()).toEqual(['Harbour yard']);
    typeInto('');
    expect(names()).toHaveLength(3);
  });

  it('opens the list when typing starts after it was closed', () => {
    mount();
    focusField();
    press('Escape');
    expect(options()).toHaveLength(0);
    typeInto('north');
    expect(names()).toEqual(['North depot']);
  });

  it('says so when no site has that name, and Enter picks nothing', () => {
    const { onPick } = mount();
    focusField();
    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toBe('');
    typeInto('zzz');
    expect(options()).toHaveLength(0);
    // the same element that was already there, so a screen reader announces its new words
    expect(host.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe('No site with that name');
    // nothing is listed, so the field does not claim an open list
    expect(q('globe-sites')).toBeNull();
    expect(field()?.getAttribute('aria-expanded')).toBe('false');
    expect(field()?.hasAttribute('aria-controls')).toBe(false);
    expect(field()?.getAttribute('aria-activedescendant')).toBeNull();
    press('Enter');
    expect(onPick).not.toHaveBeenCalled();
    typeInto('');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it('Enter picks the top match of what was typed, and nothing from an untouched list', () => {
    const { onPick } = mount();
    focusField();
    press('Enter');
    expect(onPick).not.toHaveBeenCalled();
    expect(options()).toHaveLength(3);
    typeInto('yard');
    press('Enter');
    expect(onPick).toHaveBeenCalledExactlyOnceWith(SITES[1]);
  });

  it('moves with the arrow keys, wrapping at both ends', () => {
    mount();
    focusField();
    const active = () =>
      options().findIndex((o) => o.id === field()?.getAttribute('aria-activedescendant'));
    // nothing is chosen until a key or the pointer chooses
    expect(active()).toBe(-1);
    press('ArrowDown');
    expect(active()).toBe(0);
    press('ArrowDown');
    expect(active()).toBe(1);
    press('ArrowUp');
    press('ArrowUp');
    expect(active()).toBe(2);
    press('ArrowDown');
    expect(active()).toBe(0);
  });

  it('ArrowDown, ArrowDown, Enter picks the second site, clears the field and closes', () => {
    const { onPick } = mount();
    focusField();
    typeInto('r');
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    expect(onPick).toHaveBeenCalledExactlyOnceWith(filterSites(SITES, 'r')[1]);
    expect(field()?.value).toBe('');
    expect(field()?.getAttribute('aria-expanded')).toBe('false');
    expect(options()).toHaveLength(0);
  });

  it('picks the second of all the sites after plain arrow presses', () => {
    const { onPick } = mount();
    focusField();
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    expect(onPick).toHaveBeenCalledExactlyOnceWith(SITES[1]);
  });

  it('picks the site that is clicked', () => {
    const { onPick } = mount();
    focusField();
    act(() => options()[2]?.click());
    expect(onPick).toHaveBeenCalledExactlyOnceWith(SITES[2]);
    expect(options()).toHaveLength(0);
  });

  it('opens with ArrowDown when it was closed, without choosing anything yet', () => {
    mount();
    focusField();
    press('Escape');
    press('ArrowDown');
    expect(options()).toHaveLength(3);
    expect(field()?.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('keeps the active option in view', () => {
    mount();
    focusField();
    press('ArrowDown');
    press('ArrowDown');
    expect(scrolled.mock.contexts.at(-1)).toBe(options()[1]);
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' });
  });

  it('marks the selected site, and only that one', () => {
    mount(SITES, 'yard');
    focusField();
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  it('lights the chip of the option under the pointer and puts it out on leaving', () => {
    const { onLight } = mount();
    focusField();
    // opening the list lights no chip: nothing is chosen yet
    expect(onLight).not.toHaveBeenCalled();
    act(() => {
      options()[2]?.dispatchEvent(new Event('pointermove', { bubbles: true }));
    });
    expect(onLight).toHaveBeenLastCalledWith('depot');
    expect(field()?.getAttribute('aria-activedescendant')).toBe(options()[2]?.id);
    act(() => {
      options()[2]?.dispatchEvent(new Event('pointerout', { bubbles: true }));
    });
    expect(onLight).toHaveBeenLastCalledWith(null);
    // the highlight goes with the chip, so Enter does not pick a row nothing shows
    expect(host.querySelector('[data-active]')).toBeNull();
    expect(field()?.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('forgets the chosen row when the list closes, whichever way it closes', () => {
    const { onPick, onLight } = mount();
    focusField();
    press('ArrowDown');
    press('Escape');
    press('ArrowDown');
    expect(options()).toHaveLength(3);
    expect(field()?.getAttribute('aria-activedescendant')).toBeNull();
    expect(host.querySelector('[data-active]')).toBeNull();
    expect(onLight).toHaveBeenLastCalledWith(null);

    // a row under the pointer, a press elsewhere, then back into the field and Enter
    act(() => {
      options()[1]?.dispatchEvent(new Event('pointermove', { bubbles: true }));
    });
    expect(onLight).toHaveBeenLastCalledWith('yard');
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    act(() => field()?.click());
    expect(field()?.getAttribute('aria-activedescendant')).toBeNull();
    expect(onLight).toHaveBeenLastCalledWith(null);
    press('Enter');
    expect(onPick).not.toHaveBeenCalled();

    // and the focus leaving for another control
    press('ArrowDown');
    const other = document.createElement('button');
    document.body.append(other);
    act(() => {
      other.focus();
    });
    act(() => field()?.focus());
    expect(field()?.getAttribute('aria-activedescendant')).toBeNull();
    press('Enter');
    expect(onPick).not.toHaveBeenCalled();
    other.remove();
  });

  it('lights the chip of the option the keyboard is on, and none once the list closes', () => {
    const { onLight } = mount();
    focusField();
    press('ArrowDown');
    expect(onLight).toHaveBeenLastCalledWith('quarry');
    press('ArrowDown');
    expect(onLight).toHaveBeenLastCalledWith('yard');
    press('Escape');
    expect(onLight).toHaveBeenLastCalledWith(null);
  });

  it('does not repeat itself while the pointer moves inside one option', () => {
    const { onLight } = mount();
    focusField();
    const move = () => {
      act(() => {
        options()[1]?.dispatchEvent(new Event('pointermove', { bubbles: true }));
      });
    };
    move();
    const calls = onLight.mock.calls.length;
    move();
    move();
    expect(onLight).toHaveBeenCalledTimes(calls);
  });

  it('puts the chip out after a pick', () => {
    const { onLight } = mount();
    focusField();
    press('ArrowDown');
    press('Enter');
    expect(onLight).toHaveBeenLastCalledWith(null);
  });

  it('Escape closes the list and the focus stays in the field', () => {
    mount();
    focusField();
    typeInto('har');
    press('Escape');
    expect(options()).toHaveLength(0);
    expect(field()?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(field());
  });

  it('lets Escape through when the list is already closed', () => {
    mount();
    focusField();
    press('Escape');
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      field()?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it('closes on a press outside, and not on a press inside', () => {
    mount();
    focusField();
    act(() => {
      field()?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      options()[0]?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(options()).toHaveLength(3);
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(options()).toHaveLength(0);
  });

  it('closes when the focus leaves for another control', () => {
    mount();
    const other = document.createElement('button');
    document.body.append(other);
    focusField();
    act(() => {
      other.focus();
    });
    expect(options()).toHaveLength(0);
    other.remove();
  });

  it('does not open when there are no sites', () => {
    mount([]);
    focusField();
    act(() => field()?.click());
    typeInto('a');
    press('ArrowDown');
    expect(q('globe-sites')).toBeNull();
    expect(field()?.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('No site with that name');
  });
});
