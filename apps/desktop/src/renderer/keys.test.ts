// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isTyping, isTypingTarget, spaceIsPlayPause } from './keys';

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

describe('isTypingTarget', () => {
  it('is true for inputs, textareas and contenteditable', () => {
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const div = document.createElement('div');
    // jsdom has no isContentEditable; the attribute is what it reads
    div.setAttribute('contenteditable', 'true');
    expect([isTypingTarget(input), isTypingTarget(area), isTypingTarget(div)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(isTypingTarget(el('<div contenteditable><b data-t>x</b></div>'))).toBe(true);
    expect(isTypingTarget(el('<div contenteditable="false"><b data-t>x</b></div>'))).toBe(false);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('is no text field inside a dialog, where isTyping still holds the keys', () => {
    const button = el('<div role="dialog"><button data-t>OK</button></div>');
    expect([isTypingTarget(button), isTyping(button)]).toEqual([false, true]);
  });
});
