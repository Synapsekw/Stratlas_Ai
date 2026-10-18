// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const draw = (
  shapes: ShapeItem[],
  look?: 'plain' | 'detections',
  onSelect?: (key: string | null) => void,
) => {
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
        {...(onSelect ? { onSelect } : {})}
      />,
    );
  });
};

const at = (type: 'pointermove' | 'pointerdown' | 'pointerup', x: number, y: number) => {
  act(() => {
    host
      .querySelector('svg')
      ?.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
  });
};
const click = (x: number, y: number) => {
  at('pointerdown', x, y);
  at('pointerup', x, y);
};
const rect = (
  key: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<ShapeItem> = {},
): ShapeItem => ({
  key,
  geom: { type: 'box', x, y, w, h },
  color: '#3adaf2',
  title: key,
  ...extra,
});
const hoveredTitle = () =>
  host.querySelector('.shape.hov')?.closest('g')?.querySelector('title')?.textContent;

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

  describe('clicks and hover pick the smallest shape under the pointer', () => {
    beforeEach(() => {
      // jsdom has no pointer capture
      Element.prototype.setPointerCapture = () => undefined;
    });
    // a person box with a helmet box inside it, the person selected (drawn on top)
    // (listed first, so neither list order nor drawing order would pick the helmet)
    const scene = (extra: Partial<ShapeItem> = {}) => [
      rect('helmet', 100, 60, 40, 30),
      rect('person', 50, 50, 200, 200, { selected: true, editable: true, ...extra }),
    ];

    it('selects a helmet nested in the selected person box', () => {
      const onSelect = vi.fn();
      draw(scene(), 'detections', onSelect);
      click(120, 75);
      expect(onSelect).toHaveBeenLastCalledWith('helmet');
    });

    it('keeps the person box when clicking its own area outside the helmet', () => {
      const onSelect = vi.fn();
      draw(scene(), 'detections', onSelect);
      click(200, 200);
      expect(onSelect).toHaveBeenLastCalledWith('person');
      // and selects it when it was not selected
      draw(scene({ selected: false, editable: false }), 'detections', onSelect);
      click(200, 200);
      expect(onSelect).toHaveBeenLastCalledWith('person');
    });

    it('hovers the shape a click would pick', () => {
      draw(scene(), 'detections');
      at('pointermove', 120, 75);
      expect(hoveredTitle()).toBe('helmet');
      at('pointermove', 200, 200);
      expect(hoveredTitle()).toBe('person');
    });

    it('ranks the two parts of a seam-wrapping box as one shape', () => {
      const onSelect = vi.fn();
      // a wide box across the seam, drawn as a thin part at the right edge and a wide one at the
      // left; a medium box overlaps the thin part. The thin part alone is smaller than the medium
      // box, but the whole wrapped box is bigger, so the medium box wins inside it.
      draw(
        [
          rect('medium', 340, 90, 60, 120),
          rect('wrap', 360, 100, 40, 100, { group: 'wrap' }),
          rect('wrap#2', 0, 100, 200, 100, { group: 'wrap' }),
        ],
        'detections',
        onSelect,
      );
      click(380, 150);
      expect(onSelect).toHaveBeenLastCalledWith('medium');
      at('pointermove', 100, 150);
      expect(host.querySelectorAll('.shape.hov')).toHaveLength(2);
    });

    it('lets equal shapes go to the selected one, then the later one', () => {
      const onSelect = vi.fn();
      draw(
        [rect('a', 10, 10, 50, 50, { selected: true }), rect('b', 10, 10, 50, 50)],
        'detections',
        onSelect,
      );
      click(30, 30);
      expect(onSelect).toHaveBeenLastCalledWith('a');
      draw([rect('a', 10, 10, 50, 50), rect('b', 10, 10, 50, 50)], 'detections', onSelect);
      click(30, 30);
      expect(onSelect).toHaveBeenLastCalledWith('b');
    });

    it('keeps the plain look picking the last drawn shape', () => {
      const onSelect = vi.fn();
      draw([rect('small', 100, 60, 40, 30), rect('big', 50, 50, 200, 200)], undefined, onSelect);
      click(120, 75);
      expect(onSelect).toHaveBeenLastCalledWith('big');
    });
  });

  it('keeps the plain look for the other viewers', () => {
    draw([box('a', 10)]);
    expect(host.querySelector('.halo')).toBeNull();
    expect(host.querySelector('g.chip')).toBeNull();
    expect(host.querySelector('text.label')?.textContent).toBe('a 80%');
  });
});
