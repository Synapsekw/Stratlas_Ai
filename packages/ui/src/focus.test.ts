// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusLost, keepFocusAlive, trapFocus } from './focus';

/** The element with `id`; the test fails when it is missing. */
function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el;
}

/** Whatever has focus; the test fails when nothing has. */
function active(): Element {
  const el = document.activeElement;
  if (!el) throw new Error('nothing has focus');
  return el;
}

const key = (el: EventTarget, k: string, shift = false) => {
  const e = new KeyboardEvent('keydown', {
    key: k,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(e);
  return e;
};

function setup() {
  document.body.innerHTML = `
    <button id="opener">Open</button>
    <div id="pop" role="dialog">
      <button id="a">A</button><input id="b" /><button id="c" disabled>C</button><a id="d" href="#x">D</a>
    </div>`;
  const opener = byId('opener');
  const pop = byId('pop');
  opener.focus();
  return { opener, pop };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('keepFocusAlive', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('moves focus from a removed control to its nearest surviving neighbour', async () => {
    document.body.innerHTML = `<main><h1>Issues</h1><ul id="list"><li><button id="del">Delete</button></li></ul>
      <div id="bar"><button id="keep">Keep</button></div></main>`;
    const stop = keepFocusAlive(document, () => document.querySelector('h1'));
    byId('del').focus();
    document.querySelector('li')?.remove();
    await tick();
    // the list is empty: the main region's first control takes focus
    expect(document.activeElement?.id).toBe('keep');
    stop();
  });

  it('falls back to the heading when nothing around is focusable', async () => {
    document.body.innerHTML = `<main><h1>Scene</h1><div id="panel"><button id="x">X</button></div></main>`;
    const stop = keepFocusAlive(document, () => document.querySelector('h1'));
    byId('x').focus();
    document.getElementById('panel')?.remove();
    await tick();
    expect(document.activeElement?.tagName).toBe('H1');
    stop();
  });

  it('leaves focus on the page when the person blurred on purpose', async () => {
    document.body.innerHTML = `<main><h1>Scene</h1><button id="x">X</button></main>`;
    const stop = keepFocusAlive(document, () => document.querySelector('h1'));
    const x = byId('x');
    x.focus();
    x.blur();
    await tick();
    expect(document.activeElement).toBe(document.body);
    stop();
  });
});

describe('trapFocus', () => {
  it('moves focus in, cycles Tab and Shift+Tab inside, and skips disabled controls', () => {
    const { pop } = setup();
    const release = trapFocus(pop);
    expect(document.activeElement?.id).toBe('a');
    byId('d').focus();
    expect(key(active(), 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('a');
    key(active(), 'Tab', true);
    expect(document.activeElement?.id).toBe('d');
    release();
  });

  it('closes on Esc and gives focus back to the opener', () => {
    const { opener, pop } = setup();
    const onEscape = vi.fn(() => {
      pop.remove();
    });
    const release = trapFocus(pop, { onEscape });
    key(active(), 'Escape');
    expect(onEscape).toHaveBeenCalledOnce();
    expect(focusLost()).toBe(true);
    release();
    expect(document.activeElement).toBe(opener);
  });

  it('leaves focus alone when the person moved it elsewhere', () => {
    const { pop } = setup();
    const other = document.createElement('button');
    document.body.append(other);
    const release = trapFocus(pop);
    other.focus();
    release();
    expect(document.activeElement).toBe(other);
  });

  it('focuses the container itself when nothing inside can take focus', () => {
    document.body.innerHTML = '<div id="empty"><p>Nothing to press</p></div>';
    const root = byId('empty');
    const release = trapFocus(root);
    expect(document.activeElement).toBe(root);
    expect(root.tabIndex).toBe(-1);
    release();
  });
});
