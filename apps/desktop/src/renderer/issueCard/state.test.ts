import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { cardFocus, isListNavKey, opensCard, startCardFocus } from './state';

/** A stand-in for window: records listeners, dispatches events with a target. */
function fakeTarget() {
  const listeners = new Map<string, ((e: Event) => void)[]>();
  return {
    addEventListener: (type: string, fn: (e: Event) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((f) => f !== fn),
      );
    },
    fire(type: string, init: { key?: string; inside?: string | null }) {
      const target = {
        closest: (sel: string) => (init.inside === sel ? {} : null),
      };
      for (const fn of listeners.get(type) ?? [])
        fn({ type, key: init.key, target } as unknown as Event);
    },
    count: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
  };
}

describe('opening the card', () => {
  it('opens for a newly selected issue only', () => {
    expect(opensCard(null, { kind: 'issue', id: 'a' }, false)).toBe(true);
    expect(opensCard({ kind: 'issue', id: 'a' }, { kind: 'issue', id: 'b' }, false)).toBe(true);
    expect(opensCard({ kind: 'issue', id: 'a' }, { kind: 'issue', id: 'a' }, false)).toBe(false);
    expect(opensCard(null, { kind: 'photo', id: 'p' }, false)).toBe(false);
    expect(opensCard({ kind: 'issue', id: 'a' }, null, false)).toBe(false);
  });

  it('does not open while the keyboard steps through an issue list', () => {
    expect(opensCard(null, { kind: 'issue', id: 'a' }, true)).toBe(false);
    expect(isListNavKey('ArrowDown')).toBe(true);
    expect(isListNavKey('Enter')).toBe(false);
  });

  it('follows the selection: pointer picks open the card, list arrows do not', () => {
    const ws = createWorkspace();
    const target = fakeTarget();
    const onOpen = vi.fn();
    const stop = startCardFocus(ws, onOpen, target);
    const seq = cardFocus.getState().seq;

    // a pin in the 3D view
    target.fire('pointerdown', { inside: '.pane-3d' });
    ws.getState().select({ kind: 'issue', id: 'a' });
    expect(onOpen).toHaveBeenLastCalledWith({ id: 'a', fromScene: true });
    expect(cardFocus.getState()).toEqual({ seq: seq + 1, id: 'a' });

    // arrow down in the register: the list stays
    target.fire('keydown', { key: 'ArrowDown', inside: '[data-issue-list]' });
    ws.getState().select({ kind: 'issue', id: 'b' });
    expect(onOpen).toHaveBeenCalledTimes(1);

    // Enter in the register opens it; a click in the right panel is not from the scene
    target.fire('keydown', { key: 'Enter', inside: '[data-issue-list]' });
    ws.getState().select({ kind: 'issue', id: 'c' });
    expect(onOpen).toHaveBeenLastCalledWith({ id: 'c', fromScene: false });
    target.fire('pointerdown', { inside: null });
    ws.getState().select({ kind: 'issue', id: 'd' });
    expect(onOpen).toHaveBeenLastCalledWith({ id: 'd', fromScene: false });
    expect(onOpen).toHaveBeenCalledTimes(3);

    stop();
    expect(target.count()).toBe(0);
    ws.getState().select({ kind: 'issue', id: 'e' });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });
});
