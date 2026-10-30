// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, dismissToast, toast, toastQueue, ToastHost, TOAST_QUEUE_MAX } from '.';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  act(() => {
    clearToasts();
  });
  vi.useRealTimers();
});

const mount = (node: ReactNode) => {
  root = createRoot(host);
  act(() => root?.render(node));
};
const say = (...args: Parameters<typeof toast>) => {
  let id = '';
  act(() => {
    id = toast(...args);
  });
  return id;
};
const cards = () => [...host.querySelectorAll<HTMLElement>('.q-toast')];
const text = () => cards().map((c) => c.querySelector('.q-toast-msg')?.textContent);
const status = () => host.querySelector('[role="status"]');
const alert = () => host.querySelector('[role="alert"]');
const tick = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe('toast', () => {
  it('one visible, rest queued: the newest shows, older ones wait their turn', () => {
    mount(<ToastHost placement="window" />);
    const a = say('Export saved');
    say('Sync done');
    expect(text()).toEqual(['Sync done']);
    expect(toastQueue()).toHaveLength(2);
    act(() => {
      dismissToast(toastQueue()[1]?.id ?? '');
    });
    expect(text()).toEqual(['Export saved']);
    act(() => {
      dismissToast(a);
    });
    expect(cards()).toHaveLength(0);
  });

  it('shows in a polite status region that stays mounted', () => {
    mount(<ToastHost placement="window" />);
    const region = status();
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
    say('Export saved', { tone: 'ok' });
    expect(status()).toBe(region);
    expect(region?.textContent).toContain('Export saved');
    expect(alert()?.textContent).toBe('');
  });

  it('error uses role alert', () => {
    mount(<ToastHost placement="window" />);
    say('Export failed: disk full', { tone: 'error' });
    expect(alert()?.textContent).toContain('Export failed: disk full');
    expect(status()?.textContent).toBe('');
    expect(cards()[0]?.getAttribute('data-tone')).toBe('error');
  });

  it('same id replaces, in place, without a second toast', () => {
    mount(<ToastHost placement="window" />);
    say('Uploading 1 of 3', { id: 'up' });
    say('Other');
    say('Uploading 2 of 3', { id: 'up' });
    expect(toastQueue().map((x) => x.message)).toEqual(['Uploading 2 of 3', 'Other']);
    act(() => {
      dismissToast(toastQueue()[1]?.id ?? '');
    });
    expect(text()).toEqual(['Uploading 2 of 3']);
  });

  it('returns its id: the one given or a new one', () => {
    expect(say('a', { id: 'mine' })).toBe('mine');
    const x = say('b');
    const y = say('c');
    expect(x).not.toBe(y);
  });

  it('times out after its ttl once visible; a waiting toast does not use up its time', () => {
    mount(<ToastHost placement="window" />);
    say('first', { ttlMs: 1000 });
    say('second', { ttlMs: 3000 });
    tick(2000); // only "second" is visible and counting
    expect(text()).toEqual(['second']);
    tick(1000);
    expect(text()).toEqual(['first']);
    tick(999);
    expect(text()).toEqual(['first']);
    tick(1);
    expect(cards()).toHaveLength(0);
  });

  it('ttl 0 stays until dismissed; tones have their own default time', () => {
    mount(<ToastHost placement="window" />);
    say('stays', { ttlMs: 0 });
    tick(60_000);
    expect(text()).toEqual(['stays']);
    act(() => {
      clearToasts();
    });
    say('warned', { tone: 'warn' });
    tick(7999);
    expect(text()).toEqual(['warned']);
    tick(1);
    expect(cards()).toHaveLength(0);
  });

  it('a replace restarts the clock', () => {
    mount(<ToastHost placement="window" />);
    say('1 of 3', { id: 'p', ttlMs: 1000 });
    tick(800);
    say('2 of 3', { id: 'p', ttlMs: 1000 });
    tick(800);
    expect(text()).toEqual(['2 of 3']);
    tick(200);
    expect(cards()).toHaveLength(0);
  });

  it('pauses while hovered and resumes with the time left', () => {
    mount(<ToastHost placement="window" />);
    say('hover me', { ttlMs: 1000 });
    tick(600);
    act(() => {
      cards()[0]?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    });
    tick(5000);
    expect(text()).toEqual(['hover me']);
    act(() => {
      cards()[0]?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    });
    tick(399);
    expect(text()).toEqual(['hover me']);
    tick(1);
    expect(cards()).toHaveLength(0);
  });

  it('pauses while the window is hidden', () => {
    mount(<ToastHost placement="window" />);
    say('away', { ttlMs: 1000 });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    tick(5000);
    expect(text()).toEqual(['away']);
    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    tick(1000);
    expect(cards()).toHaveLength(0);
    hidden.mockRestore();
  });

  it('the action runs once and dismisses the toast', () => {
    mount(<ToastHost placement="window" />);
    const run = vi.fn();
    say('2 measurements deleted', { action: { label: 'Undo', run, testId: 'undo' } });
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="undo"]');
    expect(btn?.textContent).toBe('Undo');
    act(() => btn?.click());
    expect(run).toHaveBeenCalledTimes(1);
    expect(cards()).toHaveLength(0);
  });

  it('the close button and Escape dismiss it and call onDismiss; a timeout does not', () => {
    mount(<ToastHost placement="window" />);
    const onDismiss = vi.fn();
    say('a', { onDismiss, testId: 'a' });
    const close = host.querySelector<HTMLButtonElement>('[data-testid="a"] [aria-label="Close"]');
    act(() => close?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    say('b', { onDismiss });
    const card = cards()[0];
    act(() => {
      card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(cards()).toHaveLength(0);
    say('c', { onDismiss, ttlMs: 100 });
    tick(100);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('shows the detail line and a given icon and test id', () => {
    mount(<ToastHost placement="window" />);
    say('Map ready', { detail: '3 layers', testId: 'map-ready' });
    const card = host.querySelector('[data-testid="map-ready"]');
    expect(card?.querySelector('.q-toast-detail')?.textContent).toBe('3 layers');
  });

  it('goes to the stage host while one is mounted, else the window host; placement pins it', () => {
    mount(
      <>
        <ToastHost placement="stage" />
        <ToastHost placement="window" />
      </>,
    );
    const inHost = (p: string) =>
      [...host.querySelectorAll(`[data-placement="${p}"] .q-toast-msg`)].map((x) => x.textContent);
    say('on stage');
    say('in the corner', { placement: 'window' });
    expect(inHost('stage')).toEqual(['on stage']);
    expect(inHost('window')).toEqual(['in the corner']);
    act(() => root?.render(<ToastHost placement="window" />));
    // the stage closed: the unplaced toast moves to the window host and waits behind the newer one
    expect(inHost('window')).toEqual(['in the corner']);
    act(() => {
      dismissToast(toastQueue().find((x) => x.placement === 'window')?.id ?? '');
    });
    expect(inHost('window')).toEqual(['on stage']);
  });

  it(`keeps at most ${String(TOAST_QUEUE_MAX)} waiting, dropping the oldest`, () => {
    for (let i = 0; i < TOAST_QUEUE_MAX + 5; i++) say(`t${String(i)}`);
    expect(toastQueue()).toHaveLength(TOAST_QUEUE_MAX);
    expect(toastQueue()[0]?.message).toBe('t5');
  });

  it('motion: rises a few pixels as it fades in; reduced motion only fades', () => {
    const css = readFileSync(join(import.meta.dirname, '../parts/toast.css'), 'utf8');
    expect(css).toMatch(/@starting-style\s*{\s*\.q-toast\s*{[^}]*translateY\(8px\)/);
    expect(css).not.toMatch(/ease-in\b|cubic-bezier/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.q-toast\s*{[^}]*transform:\s*none/);
    expect(css).toMatch(/:root\[data-motion='reduce'\] \.q-toast\s*{[^}]*transform:\s*none/);
  });
});
