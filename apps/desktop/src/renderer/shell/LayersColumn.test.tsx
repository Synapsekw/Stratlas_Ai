// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { escapeClosesOverlay } from './LayersColumn';

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
