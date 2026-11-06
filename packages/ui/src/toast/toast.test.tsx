// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, useLayoutEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearToasts,
  dismissToast,
  isToastVisible,
  Progress,
  toast,
  toastQueue,
  ToastHost,
  TOAST_QUEUE_MAX,
} from '.';

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

  it('a toast placed on the stage shows in the window corner while no stage host is mounted', () => {
    mount(<ToastHost placement="window" />);
    say('Survey prepared', { placement: 'stage' });
    expect(text()).toEqual(['Survey prepared']);
  });

  it('a replace that removes the focused action button does not leave the clock paused', () => {
    mount(<ToastHost placement="window" />);
    say('Deleted', { id: 'd', ttlMs: 1000, action: { label: 'Undo', run: vi.fn(), testId: 'u' } });
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="u"]')?.focus();
    });
    tick(5000);
    expect(text()).toEqual(['Deleted']);
    say('Deleted for good', { id: 'd', ttlMs: 1000 });
    tick(1000);
    expect(cards()).toHaveLength(0);
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
  it('a body draws under the message; the close button takes a name and test id, or goes', () => {
    mount(<ToastHost placement="window" />);
    const Body = () => <button type="button">Reload</button>;
    say('Changed on disk', { body: Body, closeLabel: 'Dismiss', closeTestId: 'x', testId: 'd' });
    const card = host.querySelector('[data-testid="d"]');
    expect(card?.hasAttribute('data-body')).toBe(true);
    expect(card?.querySelector('.q-toast-body button')?.textContent).toBe('Reload');
    expect(card?.querySelector('[data-testid="x"]')?.getAttribute('aria-label')).toBe('Dismiss');
    say('Line up dates', { body: Body, closable: false, testId: 'o' });
    expect(host.querySelector('[data-testid="o"] [aria-label="Close"]')).toBeNull();
  });

  it('an empty message leaves only the body', () => {
    mount(<ToastHost placement="window" />);
    say('', { body: () => <span>all of it</span> });
    expect(host.querySelector('.q-toast-msg')).toBeNull();
    expect(host.querySelector('.q-toast-body')?.textContent).toBe('all of it');
  });
  it('Escape on a toast without a close button keeps it and only moves focus away', () => {
    mount(<ToastHost placement="window" />);
    const onDismiss = vi.fn();
    say('Exporting', { closable: false, onDismiss, testId: 'run' });
    const card = host.querySelector<HTMLElement>('[data-testid="run"]');
    act(() => card?.focus());
    expect(document.activeElement).toBe(card);
    act(() => {
      card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(text()).toEqual(['Exporting']);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(card);
  });

  it('an error is not covered by a newer notice; a count says how many wait', () => {
    mount(<ToastHost placement="window" />);
    say('Saving failed', { tone: 'error', ttlMs: 0 });
    say('1 measurement deleted', { ttlMs: 0 });
    say('Export saved', { ttlMs: 0 });
    expect(text()).toEqual(['Saving failed']);
    expect(alert()?.textContent).toContain('Saving failed');
    expect(host.querySelector('[data-testid="toast-waiting-window"]')?.textContent).toBe('2 more');
    act(() => {
      dismissToast(toastQueue()[0]?.id ?? '');
    });
    expect(text()).toEqual(['Export saved']);
    expect(host.querySelector('[data-testid="toast-waiting-window"]')?.textContent).toBe('1 more');
    act(() => {
      clearToasts();
    });
    expect(host.querySelector('[data-testid="toast-waiting-window"]')).toBeNull();
  });

  it('isToastVisible: only the toast a mounted host shows', () => {
    say('alone', { id: 'a', ttlMs: 0 });
    expect(isToastVisible('a')).toBe(false); // no host on screen
    mount(<ToastHost placement="window" />);
    expect(isToastVisible('a')).toBe(true);
    say('newer', { id: 'b', ttlMs: 0 });
    expect(isToastVisible('a')).toBe(false);
    expect(isToastVisible('b')).toBe(true);
    expect(isToastVisible('nope')).toBe(false);
  });

  it('a held host shows nothing and its toast is not visible, so its keys do not act', () => {
    say('undo', { id: 'u', ttlMs: 0 });
    mount(<ToastHost placement="stage" held />);
    expect(isToastVisible('u')).toBe(false);
    expect(document.querySelector('.q-toast')).toBeNull();
    act(() => root?.render(<ToastHost placement="stage" />));
    expect(isToastVisible('u')).toBe(true);
  });

  it('a host held again holds its toast in the same commit: no frame counts it as visible', () => {
    say('undo', { id: 'u', ttlMs: 0 });
    // a sibling after the host reads the store as the commit lands, before anything is painted
    const seen: boolean[] = [];
    function Reader({ held }: { held: boolean }) {
      useLayoutEffect(() => {
        seen.push(isToastVisible('u'));
      }, [held]);
      return null;
    }
    const tree = (held: boolean) => (
      <>
        <ToastHost placement="stage" held={held} />
        <Reader held={held} />
      </>
    );
    mount(tree(false));
    expect(isToastVisible('u')).toBe(true);
    seen.length = 0;
    act(() => root?.render(tree(true)));
    expect(seen).toEqual([false]);
    expect(isToastVisible('u')).toBe(false);
  });

  it('focus on a toast moves to the newer one that takes its place', () => {
    mount(<ToastHost placement="window" />);
    say('first', { ttlMs: 0, testId: 'one' });
    const first = host.querySelector<HTMLElement>('[data-testid="one"]');
    act(() => first?.focus());
    say('second', { ttlMs: 0, testId: 'two' });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="two"]'));
  });

  it('an offer raised before an info toast stays in front of it; the info waits its turn', () => {
    mount(<ToastHost placement="window" />);
    const run = vi.fn();
    say('Place 2 findings on the model?', {
      id: 'offer',
      ttlMs: 0,
      action: { label: 'Place', run },
    });
    say('Every suggestion here is checked.', { id: 'done', tone: 'ok' });
    expect(text()).toEqual(['Place 2 findings on the model?']);
    expect(isToastVisible('offer')).toBe(true);
    expect(isToastVisible('done')).toBe(false);
    expect(host.querySelector('[data-testid="toast-waiting-window"]')?.textContent).toBe('1 more');
    tick(60_000); // the waiting info does not use up its time
    expect(toastQueue().map((x) => x.id)).toEqual(['offer', 'done']);
    act(() => {
      dismissToast('offer');
    });
    expect(text()).toEqual(['Every suggestion here is checked.']);
  });

  it('a toast with buttons in its body, or an undo with a timeout, is not hidden by info', () => {
    mount(<ToastHost placement="window" />);
    say('1 measurement deleted', { id: 'undo', action: { label: 'Undo', run: vi.fn() } });
    say('Synced', { id: 'info' });
    expect(text()).toEqual(['1 measurement deleted']);
    act(() => {
      dismissToast('undo');
    });
    say('Dropped to ground', {
      id: 'drop',
      ttlMs: 0,
      body: () => <button type="button">Undo</button>,
    });
    expect(text()).toEqual(['Dropped to ground']);
    expect(isToastVisible('drop')).toBe(true);
  });

  it('actionable false: a body without buttons waits behind newer info like any notice', () => {
    mount(<ToastHost placement="window" />);
    say('Export saved', {
      id: 'saved',
      ttlMs: 0,
      body: () => <span>file.las</span>,
      actionable: false,
    });
    say('Synced', { id: 'info', ttlMs: 0 });
    expect(text()).toEqual(['Synced']);
  });

  it('errors stay first; among offers the newest shows', () => {
    mount(<ToastHost placement="window" />);
    const act1 = { label: 'Yes', run: vi.fn() };
    say('Saving failed', { id: 'err', tone: 'error', ttlMs: 0 });
    say('Older offer', { id: 'o1', ttlMs: 0, action: act1 });
    say('Newer offer', { id: 'o2', ttlMs: 0, action: act1 });
    say('Info', { id: 'i', ttlMs: 0 });
    expect(text()).toEqual(['Saving failed']);
    expect(host.querySelector('[data-testid="toast-waiting-window"]')?.textContent).toBe('3 more');
    act(() => {
      dismissToast('err');
    });
    expect(text()).toEqual(['Newer offer']);
    act(() => {
      dismissToast('o2');
    });
    expect(text()).toEqual(['Older offer']);
    act(() => {
      dismissToast('o1');
    });
    expect(text()).toEqual(['Info']);
  });

  it('focus on an info toast moves to an offer that takes its place', () => {
    mount(<ToastHost placement="window" />);
    say('first', { ttlMs: 0, testId: 'one' });
    const first = host.querySelector<HTMLElement>('[data-testid="one"]');
    act(() => first?.focus());
    say('offer', { ttlMs: 0, testId: 'two', action: { label: 'Go', run: vi.fn() } });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="two"]'));
  });
});

describe('Progress', () => {
  it('a labelled bar is a progressbar with its value; unknown has no value; unlabelled is hidden', () => {
    mount(
      <>
        <Progress pct={40} label="Installing" testId="a" />
        <Progress pct={null} label="Installing" testId="b" />
        <Progress pct={10} testId="c" />
      </>,
    );
    const a = host.querySelector('[data-testid="a"]');
    expect(a?.getAttribute('role')).toBe('progressbar');
    expect(a?.getAttribute('aria-valuenow')).toBe('40');
    const b = host.querySelector('[data-testid="b"]');
    expect(b?.hasAttribute('aria-valuenow')).toBe(false);
    expect(b?.hasAttribute('data-busy')).toBe(true);
    const c = host.querySelector('[data-testid="c"]');
    expect(c?.getAttribute('aria-hidden')).toBe('true');
    expect(c?.hasAttribute('role')).toBe(false);
  });
});
