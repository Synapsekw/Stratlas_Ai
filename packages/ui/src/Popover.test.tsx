// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Popover } from './Popover';

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

function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} type="button" data-testid="opener">
        open
      </button>
      <button type="button" data-testid="outside">
        elsewhere
      </button>
      <Popover open={open} onClose={onClose} opener={opener} className="pop">
        <button type="button" data-testid="inside">
          in
        </button>
      </Popover>
    </>
  );
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (open: boolean, onClose: () => void) => {
  root = createRoot(host);
  act(() => root?.render(<Harness open={open} onClose={onClose} />));
};
const press = (el: Element | null) => {
  act(() => {
    el?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  });
};

describe('Popover', () => {
  it('renders nothing while closed', () => {
    render(false, vi.fn());
    expect(host.querySelector('.pop')).toBeNull();
  });
  it('renders its children in a box with the class', () => {
    render(true, vi.fn());
    expect(host.querySelector('.pop [data-testid="inside"]')).not.toBeNull();
  });
  it('closes on a press outside, not on the opener or inside', () => {
    const onClose = vi.fn();
    render(true, onClose);
    press(q('inside'));
    press(q('opener'));
    expect(onClose).not.toHaveBeenCalled();
    press(q('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(true, onClose);
    act(() => {
      q('inside')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function Anchored({ anchor, onClose }: { anchor: 'above' | 'below'; onClose: () => void }) {
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} type="button" data-testid="opener">
        open
      </button>
      <Popover open onClose={onClose} opener={opener} className="pop" anchor={anchor}>
        <button type="button" data-testid="inside">
          in
        </button>
      </Popover>
    </>
  );
}
const renderAnchored = (anchor: 'above' | 'below', onClose: () => void, winWidth = 1000) => {
  // the opener sits at x 100..180, y 600..624; the popover is 200 x 150
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.testid === 'opener'
      ? new DOMRect(100, 600, 80, 24)
      : new DOMRect(0, 0, 200, 150);
  });
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(winWidth);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(700);
  root = createRoot(host);
  act(() => root?.render(<Anchored anchor={anchor} onClose={onClose} />));
  return document.body.querySelector<HTMLElement>('.pop');
};

describe('Popover anchored to its opener', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('renders outside its parent, fixed above the opener', () => {
    const pop = renderAnchored('above', vi.fn());
    expect(pop).not.toBeNull();
    expect(host.contains(pop)).toBe(false);
    expect(pop?.style.position).toBe('fixed');
    expect(pop?.style.left).toBe('100px');
    // 4 px above the opener's top edge
    expect(pop?.style.bottom).toBe('104px');
    expect(pop?.style.top).toBe('auto');
  });
  it('opens below the opener', () => {
    const pop = renderAnchored('below', vi.fn());
    expect(pop?.style.top).toBe('628px');
    expect(pop?.style.bottom).toBe('auto');
  });
  it('stays inside the window on the right', () => {
    // 200 px wide in a 250 px window: 250 - 200 - 8
    const pop = renderAnchored('above', vi.fn(), 250);
    expect(pop?.style.left).toBe('42px');
  });
  it('still closes on a press outside, not inside', () => {
    const onClose = vi.fn();
    const pop = renderAnchored('above', onClose);
    press(pop?.querySelector('[data-testid="inside"]') ?? null);
    expect(onClose).not.toHaveBeenCalled();
    press(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
