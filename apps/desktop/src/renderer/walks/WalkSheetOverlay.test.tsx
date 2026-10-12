// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalkDrawing } from './walkOverlay';
import { WalkSheetOverlay } from './WalkSheetOverlay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.setPointerCapture = () => undefined;

const drawing = (over: Partial<WalkDrawing> = {}): WalkDrawing => ({
  id: 'walk-a',
  colour: 'var(--date-2)',
  placing: true,
  line: [
    {
      pts: [
        [0, 0],
        [10, 0],
      ],
      dashed: false,
    },
    {
      pts: [
        [10, 0],
        [20, 5],
      ],
      dashed: true,
    },
  ],
  stills: [
    [0, 0],
    [10, 0],
  ],
  pins: [
    { at: [0, 0], n: 1, index: 1, active: true },
    { at: [20, 5], n: 2, index: 0, active: false },
  ],
  now: { at: [5, 0], headingRad: Math.PI / 2 },
  ...over,
});

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

function render(el: React.ReactElement) {
  act(() => {
    root.render(el);
  });
}

function pointer(el: Element, type: string, x: number, y: number) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  act(() => {
    el.dispatchEvent(e);
  });
}

describe('WalkSheetOverlay', () => {
  it('draws the line runs, stills, numbered pins and the position at a constant screen size', () => {
    render(<WalkSheetOverlay drawings={[drawing()]} scale={2} />);
    const runs = host.querySelectorAll('[data-testid="walk-line"]');
    expect(runs).toHaveLength(2);
    expect(runs[0]?.getAttribute('stroke-width')).toBe('1');
    expect(runs[0]?.getAttribute('stroke-dasharray')).toBeNull();
    expect(runs[1]?.getAttribute('stroke-dasharray')).toBe('3 2');
    expect(runs[0]?.getAttribute('stroke')).toBe('var(--date-2)');
    const stills = host.querySelectorAll('[data-testid="walk-still"]');
    expect(stills).toHaveLength(2);
    expect(stills[0]?.getAttribute('r')).toBe('0.75');
    const pins = [...host.querySelectorAll('[data-testid="walk-pin"]')];
    expect(pins.map((p) => p.querySelector('text')?.textContent)).toEqual(['1', '2']);
    expect(pins[0]?.getAttribute('transform')).toBe('translate(0 0) scale(0.5)');
    expect(pins[1]?.classList.contains('inactive')).toBe(true);
    expect(pins[1]?.querySelector('title')?.textContent).toBe('The drawing it was on is gone');
    const now = host.querySelector('[data-testid="walk-now"]');
    expect(now?.getAttribute('transform')).toBe('translate(5 0) rotate(90) scale(0.5)');
  });

  it('dims a walk that is not being placed', () => {
    render(<WalkSheetOverlay drawings={[drawing({ placing: false, pins: [] })]} scale={1} />);
    const g = host.querySelector('[data-testid="walk-drawing"]');
    expect(g?.getAttribute('opacity')).toBe('0.6');
  });

  it('drags a pin to the pixel under the pointer, by its calibration index', () => {
    const onPinDrag = vi.fn();
    const toImage = (x: number, y: number): [number, number] => [x / 2, y / 2];
    const parentDown = vi.fn();
    render(
      <div onPointerDown={parentDown}>
        <WalkSheetOverlay
          drawings={[drawing()]}
          scale={2}
          onPinDrag={onPinDrag}
          toImage={toImage}
        />
      </div>,
    );
    const pin = host.querySelector('[data-testid="walk-pin"]');
    if (!pin) throw new Error('no pin');
    pointer(pin, 'pointerdown', 0, 0);
    // the picture does not pan under a pin drag
    expect(parentDown).not.toHaveBeenCalled();
    pointer(pin, 'pointermove', 40, 20);
    pointer(pin, 'pointerup', 40, 20);
    expect(onPinDrag).toHaveBeenCalledWith('walk-a', 1, [20, 10]);
    // without a drag handler pins let the press through (pan, click to pick)
    render(
      <div onPointerDown={parentDown}>
        <WalkSheetOverlay drawings={[drawing()]} scale={2} />
      </div>,
    );
    const still = host.querySelector('[data-testid="walk-pin"]');
    if (!still) throw new Error('no pin');
    pointer(still, 'pointerdown', 0, 0);
    expect(parentDown).toHaveBeenCalled();
  });
});
