// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeClosesOverlay, onStageSurface, swallowRestOfGesture } from './LayersColumn';

/** A column holding `inner` (HTML), and the element `pick` finds in it. */
function inColumn(inner: string, pick: string): Element {
  const col = document.createElement('aside');
  col.className = 'sidebar layers-col';
  col.setAttribute('role', 'dialog');
  col.innerHTML = inner;
  document.body.append(col);
  const at = col.querySelector(pick);
  if (!at) throw new Error(`no ${pick}`);
  return at;
}

const esc = (target: Element, defaultPrevented = false) => ({
  key: 'Escape',
  defaultPrevented,
  target,
});

describe('Escape in the Layers overlay closes only the innermost thing', () => {
  it('closes the overlay from a row of the tree', () => {
    const row = inColumn(
      '<div role="tree"><div role="treeitem" tabindex="0">a</div></div>',
      '[role="treeitem"]',
    );
    expect(escapeClosesOverlay(esc(row))).toBe(true);
  });

  it('leaves an Escape another part used, or another key', () => {
    const row = inColumn('<div role="treeitem" tabindex="0">a</div>', '[role="treeitem"]');
    expect(escapeClosesOverlay(esc(row, true))).toBe(false);
    expect(escapeClosesOverlay({ key: 'Enter', defaultPrevented: false, target: row })).toBe(false);
  });

  it('leaves an Escape typed in a field', () => {
    for (const [inner, pick] of [
      ['<input />', 'input'],
      ['<textarea></textarea>', 'textarea'],
      ['<div contenteditable="true"><span>x</span></div>', 'span'],
    ] as [string, string][])
      expect(escapeClosesOverlay(esc(inColumn(inner, pick)))).toBe(false);
  });

  it('leaves an Escape inside a menu, a popover or the Remove placement question', () => {
    for (const [inner, pick] of [
      ['<div role="menu"><button>x</button></div>', 'button'],
      ['<div class="popover"><button>x</button></div>', 'button'],
      ['<div role="dialog"><button>x</button></div>', 'button'],
      [
        '<div class="trow-confirm" role="group"><button data-testid="walk-unplace-cancel">No</button></div>',
        'button',
      ],
    ] as [string, string][])
      expect(escapeClosesOverlay(esc(inColumn(inner, pick)))).toBe(false);
  });
});

describe('a press that closes the overlay', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  /** A target on the page that counts the events reaching it. */
  function target() {
    const el = document.createElement('div');
    document.body.append(el);
    const heard: string[] = [];
    for (const k of ['pointerup', 'mouseup', 'click', 'contextmenu', 'auxclick'])
      el.addEventListener(k, (e) => heard.push(e.type));
    const fire = (type: string, pointerId = 1) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(e, { pointerId });
      el.dispatchEvent(e);
    };
    return { heard, fire };
  }

  it('is dismiss-only on the 3D view or the map, not on the island or a panel', () => {
    document.body.innerHTML =
      '<div class="stage"><div data-scene-view><canvas></canvas></div><div class="island"><button>x</button></div></div><aside class="right"><button>t</button></aside>';
    const q = (sel: string): Element => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no ${sel}`);
      return el;
    };
    expect(onStageSurface(q('canvas'))).toBe(true);
    expect(onStageSurface(q('[data-scene-view]'))).toBe(true);
    expect(onStageSurface(q('.island button'))).toBe(false);
    expect(onStageSurface(q('.right button'))).toBe(false);
  });

  it('drops one right-click gesture, and the next left click goes through', () => {
    vi.useFakeTimers();
    const { heard, fire } = target();
    swallowRestOfGesture(1);
    fire('pointerup');
    fire('mouseup');
    fire('contextmenu');
    vi.runAllTimers();
    expect(heard).toEqual([]);
    fire('pointerup');
    fire('click');
    expect(heard).toEqual(['pointerup', 'click']);
  });

  it('holds however long the press lasts, and only its own pointer ends it', () => {
    vi.useFakeTimers();
    const { heard, fire } = target();
    swallowRestOfGesture(1);
    vi.advanceTimersByTime(5000);
    // another pointer's events are its own, and leave this gesture held
    fire('pointerup', 2);
    vi.runAllTimers();
    expect(heard).toEqual(['pointerup']);
    fire('pointerup');
    fire('click');
    vi.runAllTimers();
    expect(heard).toEqual(['pointerup']);
    fire('click');
    expect(heard).toEqual(['pointerup', 'click']);
  });
});
