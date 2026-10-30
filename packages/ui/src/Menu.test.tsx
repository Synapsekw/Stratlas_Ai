// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';
import { Menu, type MenuEntry } from './Menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

function show(items: readonly MenuEntry[], onClose: () => void = vi.fn()) {
  function H() {
    const opener = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={opener} type="button" data-testid="opener">
          open
        </button>
        <Menu open onClose={onClose} opener={opener} label="Actions" items={items} />
      </>
    );
  }
  root = createRoot(host);
  act(() => root?.render(<H />));
}
const rows = () => [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
const key = (el: Element | null, k: string) => {
  act(() => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
};
const abc: MenuEntry[] = [
  { id: 'a', label: 'A', onSelect: vi.fn() },
  'separator',
  { id: 'b', label: 'B', onSelect: vi.fn() },
  { id: 'c', label: 'C', onSelect: vi.fn() },
];

describe('Menu', () => {
  it('renders a named menu of menuitems', () => {
    show(abc);
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.getAttribute('aria-label')).toBe('Actions');
    expect(rows().map((r) => r.getAttribute('role'))).toEqual(['menuitem', 'menuitem', 'menuitem']);
    expect(rows()[0]?.classList.contains('row')).toBe(true);
    expect(rows()[0]?.getAttribute('data-kind')).toBe('menu');
  });
  it('uses menuitemcheckbox when checked is defined', () => {
    show([{ id: 'a', label: 'A', checked: true, onSelect: vi.fn() }]);
    expect(rows()[0]?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(rows()[0]?.getAttribute('aria-checked')).toBe('true');
  });
  it('moves focus with arrows, wraps, Home and End', () => {
    show(abc);
    const menu = document.body.querySelector('[role="menu"]');
    const r = rows();
    r[0]?.focus();
    key(menu, 'ArrowDown');
    expect(document.activeElement).toBe(r[1]);
    key(menu, 'End');
    expect(document.activeElement).toBe(r[2]);
    key(menu, 'ArrowDown');
    expect(document.activeElement).toBe(r[0]);
    key(menu, 'ArrowUp');
    expect(document.activeElement).toBe(r[2]);
    key(menu, 'Home');
    expect(document.activeElement).toBe(r[0]);
  });
  it('closes before it selects', () => {
    const order: string[] = [];
    show([{ id: 'a', label: 'A', onSelect: () => order.push('select') }], () =>
      order.push('close'),
    );
    act(() => rows()[0]?.click());
    expect(order).toEqual(['close', 'select']);
  });
  it('a disabled item explains itself and does nothing', () => {
    const onSelect = vi.fn();
    show([{ id: 'a', label: 'A', disabledReason: 'No selection', onSelect }]);
    const r = rows()[0];
    expect(r?.getAttribute('aria-disabled')).toBe('true');
    expect(r?.getAttribute('aria-description')).toBe('No selection');
    act(() => r?.click());
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('Escape closes and focus returns to the opener', async () => {
    function H() {
      const opener = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(true);
      return (
        <>
          <button ref={opener} type="button" data-testid="opener">
            open
          </button>
          <Menu
            open={open}
            onClose={() => {
              setOpen(false);
            }}
            opener={opener}
            label="Actions"
            items={abc}
          />
        </>
      );
    }
    root = createRoot(host);
    act(() => root?.render(<H />));
    rows()[0]?.focus();
    expect(document.activeElement).toBe(rows()[0]);
    key(document.activeElement, 'Escape');
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-testid="opener"]'));
  });

  it('opens above the dialog its opener sits in', () => {
    function InDialog() {
      const opener = useRef<HTMLButtonElement>(null);
      return (
        <div role="dialog" aria-modal="true" aria-label="Export">
          <button ref={opener} type="button">
            open
          </button>
          <Menu open onClose={vi.fn()} opener={opener} label="Actions" items={abc} />
        </div>
      );
    }
    root = createRoot(host);
    act(() => root?.render(<InDialog />));
    const pop = document.body.querySelector('.menu-pop');
    expect(pop?.parentElement?.getAttribute('data-layer')).toBe('top');
  });

  it('stays on the popover layer outside a dialog', () => {
    show(abc);
    const pop = document.body.querySelector('.menu-pop');
    expect(pop?.parentElement?.hasAttribute('data-layer')).toBe(false);
  });
  it('arrow keys rove: only the current item is in the tab order', () => {
    show(abc);
    const r = rows();
    expect(document.activeElement).toBe(r[0]);
    expect(r.map((x) => x.tabIndex)).toEqual([0, -1, -1]);
    key(document.activeElement, 'ArrowDown');
    expect(document.activeElement).toBe(r[1]);
    expect(r.map((x) => x.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('typeahead jumps to the next item starting with what was typed', () => {
    vi.useFakeTimers();
    try {
      show([
        { id: 'copy', label: 'Copy', onSelect: vi.fn() },
        { id: 'cut', label: 'Cut', onSelect: vi.fn() },
        { id: 'paste', label: 'Paste', onSelect: vi.fn() },
        { id: 'clear', label: 'Clear', onSelect: vi.fn() },
      ]);
      const r = rows();
      key(document.activeElement, 'p');
      expect(document.activeElement).toBe(r[2]);
      vi.advanceTimersByTime(600);
      // "c" again and again walks the C items from where focus is
      key(document.activeElement, 'c');
      expect(document.activeElement).toBe(r[3]);
      vi.advanceTimersByTime(600);
      key(document.activeElement, 'c');
      expect(document.activeElement).toBe(r[0]);
      vi.advanceTimersByTime(600);
      // a quick "cu" is one prefix
      key(document.activeElement, 'c');
      key(document.activeElement, 'u');
      expect(document.activeElement).toBe(r[1]);
      // no match leaves focus where it is
      vi.advanceTimersByTime(600);
      key(document.activeElement, 'z');
      expect(document.activeElement).toBe(r[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Space still presses the focused item, also after a typed letter has timed out', () => {
    vi.useFakeTimers();
    try {
      show([{ id: 'a', label: 'A', onSelect: vi.fn() }]);
      const space = () => {
        const e = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
        act(() => {
          document.activeElement?.dispatchEvent(e);
        });
        return e.defaultPrevented;
      };
      expect(space()).toBe(false);
      key(document.activeElement, 'a');
      vi.advanceTimersByTime(600);
      expect(space()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Tab closes the menu instead of cycling inside it', () => {
    const onClose = vi.fn();
    show(abc, onClose);
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      document.activeElement?.dispatchEvent(e);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('marks a button opener with aria-haspopup and aria-expanded', () => {
    function H() {
      const opener = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            ref={opener}
            type="button"
            data-testid="opener"
            onClick={() => {
              setOpen(true);
            }}
          >
            open
          </button>
          <Menu
            open={open}
            onClose={() => {
              setOpen(false);
            }}
            opener={opener}
            label="Actions"
            items={abc}
          />
        </>
      );
    }
    root = createRoot(host);
    act(() => root?.render(<H />));
    const opener = host.querySelector<HTMLButtonElement>('[data-testid="opener"]');
    expect(opener?.getAttribute('aria-haspopup')).toBe('menu');
    expect(opener?.getAttribute('aria-expanded')).toBe('false');
    act(() => opener?.click());
    expect(opener?.getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves a non-button opener (a tree row) alone', () => {
    function H() {
      const opener = useRef<HTMLDivElement>(null);
      return (
        <>
          <div ref={opener} role="treeitem" aria-expanded="true" tabIndex={0} data-testid="row">
            row
          </div>
          <Menu open onClose={vi.fn()} opener={opener} label="Actions" items={abc} />
        </>
      );
    }
    root = createRoot(host);
    act(() => root?.render(<H />));
    const row = host.querySelector('[data-testid="row"]');
    expect(row?.hasAttribute('aria-haspopup')).toBe(false);
    expect(row?.getAttribute('aria-expanded')).toBe('true');
  });

  it('a dialog opened from an item hands focus back to the menu opener', async () => {
    function H() {
      const opener = useRef<HTMLButtonElement>(null);
      const [menu, setMenu] = useState(true);
      const [dlg, setDlg] = useState(false);
      return (
        <>
          <button ref={opener} type="button" data-testid="opener">
            open
          </button>
          <Menu
            open={menu}
            onClose={() => {
              setMenu(false);
            }}
            opener={opener}
            label="Actions"
            items={[
              {
                id: 'props',
                label: 'Properties',
                onSelect: () => {
                  setDlg(true);
                },
              },
            ]}
          />
          <Dialog
            open={dlg}
            title="Properties"
            onClose={() => {
              setDlg(false);
            }}
          >
            <input aria-label="name" data-testid="name" />
          </Dialog>
        </>
      );
    }
    root = createRoot(host);
    act(() => root?.render(<H />));
    act(() => rows()[0]?.click());
    await act(async () => {
      await Promise.resolve();
    });
    const name = document.body.querySelector<HTMLElement>('[data-testid="name"]');
    expect(document.activeElement).toBe(name);
    act(() => {
      name?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="opener"]'));
  });

  describe('submenus', () => {
    const fileUnder = vi.fn();
    const nested: MenuEntry[] = [
      { id: 'rename', label: 'Rename', onSelect: vi.fn() },
      {
        id: 'file',
        label: 'File under',
        testId: 'file-under',
        children: [
          { id: 'd1', label: '3 Oct 2026', onSelect: fileUnder },
          { id: 'd2', label: '17 Oct 2026', onSelect: vi.fn() },
        ],
      },
      { id: 'locked', label: 'Position', disabledReason: 'Locked', children: [] },
    ];
    const menus = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"]')];
    const parent = () => document.body.querySelector<HTMLElement>('[data-testid="file-under"]');

    it('an item with children says it has a submenu', () => {
      show(nested);
      expect(parent()?.getAttribute('aria-haspopup')).toBe('menu');
      expect(parent()?.getAttribute('aria-expanded')).toBe('false');
      expect(parent()?.querySelector('.menu-chev')).not.toBeNull();
    });

    it('right arrow opens a submenu, left closes it', () => {
      show(nested);
      parent()?.focus();
      key(document.activeElement, 'ArrowRight');
      expect(menus()).toHaveLength(2);
      const sub = menus()[1];
      expect(sub?.getAttribute('aria-label')).toBe('File under');
      expect(parent()?.getAttribute('aria-expanded')).toBe('true');
      expect(parent()?.getAttribute('aria-controls')).toBe(sub?.id);
      expect(document.activeElement?.textContent).toBe('3 Oct 2026');
      key(document.activeElement, 'ArrowDown');
      expect(document.activeElement?.textContent).toBe('17 Oct 2026');
      key(document.activeElement, 'ArrowLeft');
      expect(menus()).toHaveLength(1);
      expect(document.activeElement).toBe(parent());
    });

    it('Escape in a submenu closes only the submenu', () => {
      const onClose = vi.fn();
      show(nested, onClose);
      parent()?.focus();
      key(document.activeElement, 'ArrowRight');
      key(document.activeElement, 'Escape');
      expect(onClose).not.toHaveBeenCalled();
      expect(menus()).toHaveLength(1);
      expect(document.activeElement).toBe(parent());
    });

    it('a click opens it; choosing in it closes the whole menu, then runs', () => {
      const order: string[] = [];
      fileUnder.mockImplementation(() => order.push('select'));
      show(nested, () => order.push('close'));
      act(() => parent()?.click());
      expect(menus()).toHaveLength(2);
      const item = menus()[1]?.querySelector<HTMLElement>('[role="menuitem"]');
      act(() => item?.click());
      expect(order).toEqual(['close', 'select']);
    });

    it('hovering opens it without taking focus; hovering a plain item closes it', () => {
      show(nested);
      const first = rows()[0];
      act(() => {
        parent()?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      });
      expect(menus()).toHaveLength(2);
      expect(document.activeElement).toBe(first);
      act(() => {
        first?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      });
      expect(menus()).toHaveLength(1);
    });

    it('a submenu opened by hover takes focus when entered by key', () => {
      show(nested);
      parent()?.focus();
      act(() => {
        parent()?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      });
      expect(menus()).toHaveLength(2);
      expect(document.activeElement).toBe(parent());
      key(document.activeElement, 'ArrowRight');
      expect(document.activeElement?.textContent).toBe('3 Oct 2026');
    });

    it('a disabled parent does not open', () => {
      show(nested);
      const locked = rows().find((r) => r.textContent === 'Position');
      locked?.focus();
      key(locked ?? null, 'ArrowRight');
      act(() => locked?.click());
      expect(menus()).toHaveLength(1);
    });

    it('the submenu sits inside the menu box, so a press on it is not outside', () => {
      const onClose = vi.fn();
      show(nested, onClose);
      parent()?.focus();
      key(document.activeElement, 'ArrowRight');
      const pop = document.body.querySelector('.menu-pop');
      expect(pop?.contains(menus()[1] ?? null)).toBe(true);
      act(() => {
        menus()[1]?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('in a right-to-left page the arrows swap', () => {
      document.documentElement.style.direction = 'rtl';
      try {
        show(nested);
        parent()?.focus();
        key(document.activeElement, 'ArrowRight');
        expect(menus()).toHaveLength(1);
        key(document.activeElement, 'ArrowLeft');
        expect(menus()).toHaveLength(2);
        key(document.activeElement, 'ArrowRight');
        expect(menus()).toHaveLength(1);
      } finally {
        document.documentElement.style.direction = '';
      }
    });
  });
});
