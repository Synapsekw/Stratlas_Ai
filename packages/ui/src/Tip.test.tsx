// @vitest-environment jsdom
import { act, createRef, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tip } from './Tip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
let clock = 1_000_000;
/**
 * Whether focus counts as keyboard focus (`:focus-visible`), which jsdom never reports: true for
 * `focus()` as a Tab would give it, false while a test plays a mouse click.
 */
let focusVisible = true;
const matches = Object.getOwnPropertyDescriptor(Element.prototype, 'matches')?.value as (
  this: Element,
  selector: string,
) => boolean;
beforeEach(() => {
  focusVisible = true;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return selector === ':focus-visible'
      ? focusVisible && document.activeElement === this
      : matches.call(this, selector);
  });
  vi.useFakeTimers();
  clock += 60_000; // the skip window is module state: keep tests apart
  vi.setSystemTime(clock);
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host.remove();
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const tip = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="tooltip"]');
function need<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('missing element');
  return value;
}
function render(ui: ReactElement): void {
  root ??= createRoot(host);
  const r = root;
  act(() => {
    r.render(ui);
  });
}
const btn = (id = 'a'): HTMLElement => need(host.querySelector<HTMLElement>(`#${id}`));
const fire = (el: Element, event: Event): void => {
  act(() => {
    el.dispatchEvent(event);
  });
};
const focus = (id = 'a'): void => {
  act(() => {
    btn(id).focus();
  });
};
const blur = (id = 'a'): void => {
  act(() => {
    btn(id).blur();
  });
};
const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};
const save = (extra: { repeatsName?: boolean; disabled?: boolean } = {}): ReactElement => (
  <Tip content="Save" repeatsName={extra.repeatsName ?? false}>
    <button id="a" type="button" aria-disabled={extra.disabled}>
      s
    </button>
  </Tip>
);

describe('Tip', () => {
  it('shows on hover after 400 ms, not before', () => {
    render(save());
    fire(btn(), new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    wait(399);
    expect(tip()).toBeNull();
    wait(1);
    expect(tip()?.textContent).toContain('Save');
  });

  it('shows on keyboard focus after 400 ms', () => {
    render(save());
    focus();
    wait(399);
    expect(tip()).toBeNull();
    wait(1);
    expect(tip()).not.toBeNull();
  });

  it('skips the delay when another tip hid under 600 ms ago', () => {
    render(
      <>
        <Tip content="One">
          <button id="a" type="button">
            1
          </button>
        </Tip>
        <Tip content="Two">
          <button id="b" type="button">
            2
          </button>
        </Tip>
      </>,
    );
    focus('a');
    wait(400);
    expect(tip()?.textContent).toContain('One');
    blur('a');
    wait(100);
    focus('b');
    expect(tip()?.textContent).toContain('Two');
  });

  it('hides on Escape and on blur', () => {
    render(save());
    focus();
    wait(400);
    fire(btn(), new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tip()).toBeNull();
    wait(1000);
    blur();
    focus();
    wait(400);
    expect(tip()).not.toBeNull();
    blur();
    expect(tip()).toBeNull();
  });

  it('links aria-describedby to the tip, or hides the tip when it repeats the name', () => {
    render(save());
    focus();
    wait(400);
    expect(btn().getAttribute('aria-describedby')).toBe(need(tip()).id);
    expect(need(tip()).hasAttribute('aria-hidden')).toBe(false);
    render(save({ repeatsName: true }));
    expect(btn().hasAttribute('aria-describedby')).toBe(false);
    expect(need(tip()).getAttribute('aria-hidden')).toBe('true');
  });

  it('renders under body wearing the opener surface', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    render(<div data-surface="dark">{save()}</div>);
    focus();
    wait(400);
    const wrapper = need(tip()?.parentElement);
    expect(host.contains(wrapper)).toBe(false);
    expect(wrapper.parentElement).toBe(document.body);
    expect(wrapper.getAttribute('data-surface')).toBe('dark');
    expect(wrapper.getAttribute('data-layer'), 'above every dialog and scrim').toBe('top');
  });

  it('shows on focus for an aria-disabled child', () => {
    render(save({ disabled: true }));
    focus();
    wait(400);
    expect(tip()?.textContent).toContain('Save');
  });

  it('does not open after a mouse click focuses the child, but does for Tab focus', () => {
    render(save());
    focusVisible = false;
    fire(btn(), new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    focus();
    fire(btn(), new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
    wait(500);
    expect(tip()).toBeNull();
    blur();
    focusVisible = true;
    focus();
    wait(400);
    expect(tip()).not.toBeNull();
  });

  it('does not open when the click and its focus land in one task', () => {
    render(save());
    focusVisible = false;
    act(() => {
      btn().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      btn().focus();
    });
    fire(btn(), new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
    wait(500);
    expect(tip()).toBeNull();
  });

  it('hides on pointer down and on pointer leave', () => {
    render(save());
    fire(btn(), new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    wait(400);
    expect(tip()).not.toBeNull();
    fire(btn(), new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    expect(tip()).toBeNull();
    fire(btn(), new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
    fire(btn(), new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
    fire(btn(), new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    wait(400);
    expect(tip()).not.toBeNull();
    fire(btn(), new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
    expect(tip()).toBeNull();
  });

  it('still hands the element to the caller ref', () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Tip content="Save">
        <button id="a" type="button" ref={ref}>
          s
        </button>
      </Tip>,
    );
    expect(ref.current).toBe(btn());
  });

  it('closes a hover-opened tip on Escape pressed anywhere', () => {
    render(save());
    fire(btn(), new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    wait(400);
    expect(tip()).not.toBeNull();
    fire(document.body, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tip()).toBeNull();
  });

  it('ignores touch hover and leaves no aria-describedby while closed', () => {
    render(save());
    expect(btn().hasAttribute('aria-describedby')).toBe(false);
    fire(btn(), new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' }));
    wait(500);
    expect(tip()).toBeNull();
  });
});
