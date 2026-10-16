// packages/ui/src/actions/ContextMenu.test.tsx
// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/unbound-method -- the run spies are asserted, never called detached */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, placeMenu } from './ContextMenu';
import type { ResolvedItem } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

const item = (id: string, over: Partial<ResolvedItem> = {}): ResolvedItem => ({
  id,
  label: id,
  section: 'view',
  disabled: false,
  shortcut: null,
  testId: `ctx-item-${id}`,
  present: 'action',
  sub: [],
  subTitle: null,
  run: vi.fn(),
  ...over,
});
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const key = (k: string, init: KeyboardEventInit = {}) => {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }),
    );
  });
};
function open(items: ResolvedItem[], over: { initialSub?: string; onClose?: () => void } = {}) {
  const onClose = over.onClose ?? vi.fn();
  root = createRoot(host);
  act(() =>
    root?.render(
      <ContextMenu
        items={items}
        x={10}
        y={10}
        label="Menu"
        title="Header"
        onClose={onClose}
        {...(over.initialSub ? { initialSub: over.initialSub } : {})}
      />,
    ),
  );
  return onClose;
}

describe('ContextMenu', () => {
  it('portals to the body with a header, sections in order and separators between them', () => {
    open([
      item('show', { section: 'view' }),
      item('open', { section: 'open' }),
      item('del', { section: 'danger' }),
    ]);
    const menu = q('ctx-menu');
    expect(menu?.parentElement).toBe(document.body);
    expect(menu?.getAttribute('role')).toBe('menu');
    expect(menu?.textContent).toContain('Header');
    const order = [...(menu?.querySelectorAll('[data-testid^="ctx-item-"], .dmenu-sep') ?? [])].map(
      (e) => e.getAttribute('data-testid') ?? 'sep',
    );
    expect(order).toEqual(['ctx-item-open', 'sep', 'ctx-item-show', 'sep', 'ctx-item-del']);
  });

  it('walks with arrows, Home and End, and type-ahead finds an item by its first letters', () => {
    open([item('alpha'), item('beta'), item('gamma')]);
    expect(document.activeElement).toBe(q('ctx-item-alpha'));
    key('ArrowDown');
    expect(document.activeElement).toBe(q('ctx-item-beta'));
    key('End');
    expect(document.activeElement).toBe(q('ctx-item-gamma'));
    key('Home');
    key('g');
    expect(document.activeElement).toBe(q('ctx-item-gamma'));
  });

  it('opens a submenu with Right, goes back with Left or Escape, and Back', () => {
    const run = vi.fn();
    open([
      item('cmp', {
        present: 'submenu',
        subTitle: 'Compare with',
        sub: [{ id: 'oct', label: 'Oct', testId: 'compare-to-oct' }],
        run,
      }),
    ]);
    key('ArrowRight');
    expect(q('compare-to-oct')).not.toBeNull();
    expect(q('ctx-menu')?.textContent).toContain('Compare with');
    key('ArrowLeft');
    expect(q('compare-to-oct')).toBeNull();
    act(() => q('ctx-item-cmp')?.click());
    key('Escape');
    expect(q('ctx-item-cmp')).not.toBeNull();
    act(() => q('ctx-item-cmp')?.click());
    act(() => q('ctx-back')?.click());
    expect(q('ctx-item-cmp')).not.toBeNull();
  });

  it('runs an item after closing; a greyed item says why and does nothing', () => {
    const go = item('go');
    const no = item('no', { disabled: 'Not here.' });
    const onClose = open([go, no]);
    act(() => q('ctx-item-no')?.click());
    expect(no.run).not.toHaveBeenCalled();
    expect(q('ctx-item-no')?.getAttribute('aria-disabled')).toBe('true');
    expect(q('ctx-item-no')?.title).toBe('Not here.');
    act(() => q('ctx-item-go')?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(go.run).toHaveBeenCalledWith(undefined);
  });

  it('runs an inline item with its id, and a pick keeps the menu open', () => {
    const move = item('move', {
      present: 'inline',
      sub: [
        { id: 'sep', label: 'Sep', testId: 'move-to-sep' },
        { id: 'every', label: 'Every', testId: 'move-to-every', disabled: 'Here.' },
      ],
    });
    const colour = item('colour', {
      present: 'picks',
      sub: [{ id: '5', label: 'Colour 5', testId: 'date-menu-colour-5', checked: true }],
    });
    const onClose = open([move, colour]);
    expect(q('move-to-every')?.getAttribute('aria-disabled')).toBe('true');
    act(() => q('date-menu-colour-5')?.click());
    expect(colour.run).toHaveBeenCalledWith('5');
    expect(onClose).not.toHaveBeenCalled();
    expect(q('date-menu-colour-5')?.getAttribute('aria-checked')).toBe('true');
    act(() => q('move-to-sep')?.click());
    expect(move.run).toHaveBeenCalledWith('sep');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens straight into a submenu, where Escape closes', () => {
    const onClose = open(
      [
        item('align', {
          present: 'submenu',
          sub: [{ id: 't', label: 'Target', testId: 'align-t' }],
        }),
      ],
      { initialSub: 'align' },
    );
    expect(q('align-t')).not.toBeNull();
    key('Escape');
    expect(onClose).toHaveBeenCalled();
  });

  it('gives focus back to the invoker on close', async () => {
    const invoker = document.createElement('button');
    document.body.append(invoker);
    invoker.focus();
    const onClose = vi.fn(() => {
      root?.render(<></>);
    });
    open([item('a')], { onClose });
    key('Escape');
    // the focus trap gives focus back in a microtask, after React removed the menu
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(invoker);
    invoker.remove();
  });
});

describe('placeMenu', () => {
  it('keeps a tall menu inside the window', () => {
    expect(placeMenu(1000, 650, 286, 520, 1100, 700)).toEqual({ left: 806, top: 172 });
    expect(placeMenu(-5, -5, 286, 100, 1100, 700)).toEqual({ left: 8, top: 8 });
  });
});
