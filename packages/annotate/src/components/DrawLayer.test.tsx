// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrawLayer, type ShapeItem } from './DrawLayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const box = (key: string, x: number, extra: Partial<ShapeItem> = {}): ShapeItem => ({
  key,
  geom: { type: 'box', x, y: 100, w: 50, h: 50 },
  color: '#3adaf2',
  label: `${key} 80%`,
  ...extra,
});

const draw = (shapes: ShapeItem[], look?: 'plain' | 'detections') => {
  act(() => {
    root.render(
      <DrawLayer
        view={{ scale: 1, x: 0, y: 0 }}
        size={{ width: 400, height: 300 }}
        tool="select"
        shapes={shapes}
        onCreate={() => undefined}
        onPan={() => undefined}
        {...(look ? { look } : {})}
      />,
    );
  });
};

const order = () =>
  [...host.querySelectorAll('.shape')].map(
    (s) => s.closest('g')?.querySelector('title')?.textContent,
  );

describe('the drawing layer in the detections look', () => {
  it('draws each shape over a halo and its label as a chip in its colour', () => {
    draw(
      [box('Helmet', 10, { title: 'Helmet 80%' }), box('No vest', 200, { color: '#cc2538' })],
      'detections',
    );
    expect(host.querySelectorAll('.shape')).toHaveLength(2);
    expect(host.querySelectorAll('.halo')).toHaveLength(2);
    expect(host.querySelector('text.label')).toBeNull();
    const chips = [...host.querySelectorAll('g.chip')];
    expect(chips.map((c) => c.textContent)).toEqual(['Helmet 80%', 'No vest 80%']);
    expect(chips[1]?.querySelector('rect')?.getAttribute('fill')).toBe('#cc2538');
    // light text on the dark crimson, dark text on the light cyan
    expect(chips[1]?.querySelector('text')?.getAttribute('fill')).toBe('#f6f7f9');
    expect(chips[0]?.querySelector('text')?.getAttribute('fill')).toBe('#15181d');
    // the chip sits just above the box's top left corner
    expect(chips[0]?.getAttribute('transform')).toBe('translate(10 82)');
    expect(chips[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('title')?.textContent).toBe('Helmet 80%');
  });

  it('draws the selected shape on top and dims the others', () => {
    draw(
      [box('a', 10, { selected: true, title: 'A' }), box('b', 30, { title: 'B' })],
      'detections',
    );
    expect(host.querySelector('svg')?.classList.contains('has-sel')).toBe(true);
    expect(order()).toEqual(['B', 'A']);
    expect(
      host.querySelector('.shape.sel')?.closest('g')?.querySelector('title')?.textContent,
    ).toBe('A');
  });

  it('thickens the shape under the pointer and brings it to the front', () => {
    draw([box('a', 10, { title: 'A' }), box('b', 200, { title: 'B' })], 'detections');
    expect(order()).toEqual(['A', 'B']);
    act(() => {
      host
        .querySelector('svg')
        ?.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 120 }),
        );
    });
    expect(order()).toEqual(['B', 'A']);
    expect(
      host.querySelector('.shape.hov')?.closest('g')?.querySelector('title')?.textContent,
    ).toBe('A');
  });

  it('keeps the plain look for the other viewers', () => {
    draw([box('a', 10)]);
    expect(host.querySelector('.halo')).toBeNull();
    expect(host.querySelector('g.chip')).toBeNull();
    expect(host.querySelector('text.label')?.textContent).toBe('a 80%');
  });
});
