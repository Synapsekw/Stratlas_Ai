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
