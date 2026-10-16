// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
