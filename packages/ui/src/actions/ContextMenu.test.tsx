// packages/ui/src/actions/ContextMenu.test.tsx
// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/unbound-method -- the run spies are asserted, never called detached */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, foldItems, placeMenu } from './ContextMenu';
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

  it('gathers two or more Position items under one Position submenu that runs each', () => {
    const place = item('place', { section: 'edit', fold: 'position', testId: 'menu-place-model' });
    const drop = item('drop', { section: 'edit', fold: 'position', disabled: 'Kit cloud.' });
    const onClose = open([
      item('rename', { section: 'edit' }),
      place,
      drop,
      item('eng', { section: 'edit' }),
    ]);
    const order = [...(q('ctx-menu')?.querySelectorAll('[role="menuitem"]') ?? [])].map((e) =>
      e.getAttribute('data-testid'),
    );
    expect(order).toEqual(['ctx-item-rename', 'ctx-fold-position', 'ctx-item-eng']);
    expect(q('ctx-fold-position')?.getAttribute('aria-haspopup')).toBe('menu');
    expect(q('ctx-fold-position')?.textContent).toContain('Position');
    act(() => q('ctx-fold-position')?.click());
    expect(q('ctx-item-drop')?.getAttribute('aria-disabled')).toBe('true');
    act(() => q('menu-place-model')?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(place.run).toHaveBeenCalled();
    expect(drop.run).not.toHaveBeenCalled();
  });

  it('a submenu of choices with a current one marks its items as radios', () => {
    open([
      item('file', {
        present: 'submenu',
        sub: [
          { id: 'sep', label: 'Sep', testId: 'move-to-sep', checked: true },
          { id: 'oct', label: 'Oct', testId: 'move-to-oct', checked: false },
        ],
      }),
    ]);
    act(() => q('ctx-item-file')?.click());
    expect(q('move-to-sep')?.getAttribute('role')).toBe('menuitemradio');
    expect(q('move-to-sep')?.getAttribute('aria-checked')).toBe('true');
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

describe('foldItems', () => {
  const label = () => 'Position';
  it('leaves a lone Position item where it is', () => {
    const one = [item('a'), item('drop', { fold: 'position' })];
    expect(foldItems(one, label).map((i) => i.id)).toEqual(['a', 'drop']);
  });

  it('greys the entry only when every item in it is greyed', () => {
    const both = [
      item('p', { fold: 'position', disabled: 'Read only.' }),
      item('d', { fold: 'position', disabled: 'Read only.' }),
    ];
    expect(foldItems(both, label)[0]?.disabled).toBe('Read only.');
    const some = [
      item('p', { fold: 'position' }),
      item('d', { fold: 'position', disabled: 'No.' }),
    ];
    expect(foldItems(some, label)[0]?.disabled).toBe(false);
  });

  it('a greyed entry says each distinct reason of its items once', () => {
    const shut = [
      item('p', { fold: 'position', disabled: 'Read only.' }),
      item('d', { fold: 'position', disabled: 'Kit cloud.' }),
      item('g', { fold: 'position', disabled: 'Read only.' }),
    ];
    expect(foldItems(shut, label)[0]?.disabled).toBe('Read only. Kit cloud.');
  });

  it('items of different sections join the first one, where it stood', () => {
    const mixed = [
      item('a', { section: 'view' }),
      item('place', { section: 'edit', fold: 'position' }),
      item('b', { section: 'edit' }),
      item('drop', { section: 'danger', fold: 'position' }),
    ];
    const out = foldItems(mixed, label);
    expect(out.map((i) => i.id)).toEqual(['a', 'fold.position', 'b']);
    expect(out[1]?.section).toBe('edit');
    expect(out[1]?.sub.map((s) => s.id)).toEqual(['place', 'drop']);
  });
});

describe('placeMenu', () => {
  it('keeps a tall menu inside the window', () => {
    expect(placeMenu(1000, 650, 286, 520, 1100, 700)).toEqual({
      left: 806,
      top: 172,
      maxHeight: 684,
    });
    expect(placeMenu(-5, -5, 286, 100, 1100, 700)).toEqual({ left: 8, top: 8, maxHeight: 684 });
  });
  it('keeps a menu taller than a small window inside it and caps its height', () => {
    // 860 px of items in a 720 px window: top at the margin, height capped to the window less 16
    const p = placeMenu(40, 500, 286, 860, 1100, 720);
    expect(p).toEqual({ left: 40, top: 8, maxHeight: 704 });
    expect(p.top + Math.min(860, p.maxHeight) + 8).toBeLessThanOrEqual(720);
  });
  it('caps the rendered menu to the window and scrolls inside it', () => {
    const was = window.innerHeight;
    window.innerHeight = 300;
    root = createRoot(host);
    act(() => {
      root?.render(
        <ContextMenu
          items={[item('a'), item('b')]}
          x={10}
          y={290}
          label="Menu"
          onClose={() => undefined}
        />,
      );
    });
    expect(q('ctx-menu')?.style.maxHeight).toBe('284px');
    window.innerHeight = was;
  });
});
