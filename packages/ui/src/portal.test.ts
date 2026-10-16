// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PortalRoot, portalSurfaceAttrs } from './portal';

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
  for (const a of ['data-theme', 'data-contrast', 'data-motion', 'dir'])
    document.documentElement.removeAttribute(a);
});

function render(node: ReactNode) {
  root = createRoot(host);
  act(() => root?.render(node));
}

describe('portalSurfaceAttrs', () => {
  it('takes the nearest values walking up from the opener, then <html>', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    host.innerHTML = '<div data-surface="dark"><button id="o"></button></div>';
    const opener = host.querySelector('#o');
    expect(portalSurfaceAttrs(opener)).toEqual({ 'data-surface': 'dark', 'data-theme': 'light' });
  });

  it('lets a nearer ancestor win over <html>', () => {
    document.documentElement.setAttribute('dir', 'ltr');
    host.innerHTML = '<div dir="rtl"><button id="o"></button></div>';
    expect(portalSurfaceAttrs(host.querySelector('#o'))).toEqual({ dir: 'rtl' });
  });

  it('gives the <html> attributes only for an opener with nothing around it', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.setAttribute('data-contrast', 'more');
    const lone = document.createElement('button');
    expect(portalSurfaceAttrs(lone)).toEqual({ 'data-theme': 'light', 'data-contrast': 'more' });
  });

  it('gives nothing for a null opener', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    expect(portalSurfaceAttrs(null)).toEqual({});
  });
});

describe('PortalRoot', () => {
  it('renders its child under document.body with the opener surface on the wrapper', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    host.innerHTML = '<div data-surface="dark"><button id="o"></button></div>';
    const opener = host.querySelector('#o');
    render(
      createElement(PortalRoot, {
        opener,
        className: 'wrap',
        children: createElement('span', { id: 'child' }, 'hi'),
      }),
    );
    const child = document.getElementById('child');
    expect(child).not.toBeNull();
    expect(host.contains(child)).toBe(false);
    const wrapper = child?.parentElement;
    expect(wrapper?.parentElement).toBe(document.body);
    expect(wrapper?.className).toBe('wrap');
    expect(wrapper?.getAttribute('data-surface')).toBe('dark');
    expect(wrapper?.getAttribute('data-theme')).toBe('light');
  });

  const layerOf = (markup: string, layer?: 'top') => {
    host.innerHTML = markup;
    render(
      createElement(PortalRoot, {
        opener: host.querySelector('#o'),
        layer,
        children: createElement('span', { id: 'child' }, 'hi'),
      }),
    );
    const wrapper = document.getElementById('child')?.parentElement;
    const value = wrapper?.getAttribute('data-layer') ?? null;
    act(() => root?.unmount());
    root = null;
    return value;
  };

  it('lifts to the top layer for an opener inside a dialog, a modal or a scrim', () => {
    expect(layerOf('<div role="dialog"><button id="o"></button></div>')).toBe('top');
    expect(layerOf('<div role="alertdialog"><button id="o"></button></div>')).toBe('top');
    expect(layerOf('<section aria-modal="true"><button id="o"></button></section>')).toBe('top');
    expect(layerOf('<div class="dlg-scrim"><div><button id="o"></button></div></div>')).toBe('top');
  });

  it('stays on the popover layer elsewhere, unless asked for the top', () => {
    expect(layerOf('<div><button id="o"></button></div>')).toBeNull();
    expect(layerOf('<div><button id="o"></button></div>', 'top')).toBe('top');
  });
});

describe('the top layer', () => {
  const part = (name: string) =>
    readFileSync(join(import.meta.dirname, 'parts', `${name}.css`), 'utf8');

  it('puts tips there always, and lifted popovers and menus', () => {
    expect(part('tip')).toMatch(/\.tip-pop \{[^}]*z-index: var\(--z-top\)/);
    expect(part('surface')).toMatch(
      /\[data-layer='top'\] > \.surface-pop \{[^}]*z-index: var\(--z-top\)/,
    );
  });
});
