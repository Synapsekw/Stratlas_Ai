// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isTyping, spaceIsPlayPause } from './keys';

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  const target = host.querySelector<HTMLElement>('[data-t]');
  if (!target) throw new Error('no target');
  return target;
}

describe('Space for play and pause', () => {
  it('plays from the page, the canvas and a stage tool button just clicked', () => {
    expect(spaceIsPlayPause(document.body)).toBe(true);
    expect(spaceIsPlayPause(el('<canvas data-t tabindex="0"></canvas>'))).toBe(true);
    expect(spaceIsPlayPause(el('<button data-t class="tool">M</button>'))).toBe(true);
    expect(spaceIsPlayPause(null)).toBe(true);
  });

  it('leaves Space to text fields, tree rows, tabs, checkboxes and dialogs', () => {
    expect(spaceIsPlayPause(el('<input data-t>'))).toBe(false);
    expect(spaceIsPlayPause(el('<input data-t type="checkbox">'))).toBe(false);
    expect(spaceIsPlayPause(el('<textarea data-t></textarea>'))).toBe(false);
    expect(spaceIsPlayPause(el('<div data-t role="treeitem" tabindex="0"></div>'))).toBe(false);
    expect(spaceIsPlayPause(el('<button data-t role="tab"></button>'))).toBe(false);
    expect(spaceIsPlayPause(el('<div role="dialog"><button data-t>OK</button></div>'))).toBe(false);
    expect(isTyping(el('<select data-t></select>'))).toBe(true);
  });
});
