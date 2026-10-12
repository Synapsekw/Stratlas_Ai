// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalkDrawing, WalkNow } from './walkOverlay';
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

const now: WalkNow = { id: 'walk-a', colour: 'var(--date-2)', at: [5, 0], headingRad: Math.PI / 2 };

describe('WalkSheetOverlay', () => {
  it('draws the line runs, stills, numbered pins and the position', () => {
    render(<WalkSheetOverlay drawings={[drawing()]} scale={2} now={now} />);
    const runs = host.querySelectorAll('[data-testid="walk-line"]');
    expect(runs).toHaveLength(2);
    // non-scaling strokes: 2 px and a 6/4 dash on screen whatever the zoom
    expect(runs[0]?.getAttribute('stroke-width')).toBe('2');
    expect(runs[0]?.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    expect(runs[0]?.getAttribute('stroke-dasharray')).toBeNull();
    expect(runs[1]?.getAttribute('stroke-dasharray')).toBe('6 4');
    expect(runs[0]?.getAttribute('stroke')).toBe('var(--date-2)');
    const stills = host.querySelectorAll('[data-testid="walk-stills"]');
    expect(stills).toHaveLength(1);
    expect(stills[0]?.getAttribute('d')).toBe('M0 0h0M10 0h0');
    expect(stills[0]?.getAttribute('stroke-width')).toBe('3');
    const pins = [...host.querySelectorAll('[data-testid="walk-pin"]')];
    expect(pins.map((p) => p.querySelector('text')?.textContent)).toEqual(['1', '2']);
    expect(pins[0]?.getAttribute('transform')).toBe('translate(0 0) scale(0.5)');
    expect(pins[1]?.classList.contains('inactive')).toBe(true);
    expect(pins[1]?.querySelector('title')?.textContent).toBe('The drawing it was on is gone');
    const marker = host.querySelector('[data-testid="walk-now"]');
    expect(marker?.getAttribute('transform')).toBe('translate(5 0) rotate(90) scale(0.5)');
  });

  it('a zoom leaves the path strings alone and moves only the pins', () => {
    const drawings = [drawing()];
    render(<WalkSheetOverlay drawings={drawings} scale={2} />);
    const before = [...host.querySelectorAll('[data-testid="walk-line"]')];
    const d0 = before.map((p) => p.getAttribute('d'));
    const stills0 = host.querySelector('[data-testid="walk-stills"]');
    render(<WalkSheetOverlay drawings={drawings} scale={8} />);
    const after = [...host.querySelectorAll('[data-testid="walk-line"]')];
    expect(after.map((p) => p.getAttribute('d'))).toEqual(d0);
    // the same elements: React did not rebuild the path layer
    expect(after[0]).toBe(before[0]);
    expect(host.querySelector('[data-testid="walk-stills"]')).toBe(stills0);
    expect(host.querySelector('[data-testid="walk-pin"]')?.getAttribute('transform')).toBe(
      'translate(0 0) scale(0.125)',
    );
  });

  it('dims a walk that is not being placed', () => {
    render(<WalkSheetOverlay drawings={[drawing({ placing: false, pins: [] })]} scale={1} />);
    const g = host.querySelector('[data-testid="walk-drawing"]');
    expect(g?.getAttribute('opacity')).toBe('0.6');
  });

  it('drags a pin on the picture by its calibration index and ends the drag once', () => {
    const onPinDrag = vi.fn();
    const onPinDragEnd = vi.fn();
    const toImage = (x: number, y: number): [number, number] => [x / 2, y / 2];
    const parentDown = vi.fn();
    render(
      <div onPointerDown={parentDown}>
        <WalkSheetOverlay
          drawings={[drawing()]}
          scale={2}
          size={{ width: 100, height: 50 }}
          onPinDrag={onPinDrag}
          onPinDragEnd={onPinDragEnd}
          toImage={toImage}
        />
      </div>,
    );
    const [pin, gone] = [...host.querySelectorAll('[data-testid="walk-pin"]')];
    if (!pin || !gone) throw new Error('no pins');
    pointer(pin, 'pointerdown', 0, 0);
    // the picture does not pan under a pin drag
    expect(parentDown).not.toHaveBeenCalled();
    pointer(pin, 'pointermove', 40, 20);
    expect(onPinDrag).toHaveBeenLastCalledWith('walk-a', 1, [20, 10]);
    // kept on the picture
    pointer(pin, 'pointermove', 400, -20);
    expect(onPinDrag).toHaveBeenLastCalledWith('walk-a', 1, [100, 0]);
    expect(onPinDragEnd).not.toHaveBeenCalled();
    pointer(pin, 'pointerup', 400, -20);
    expect(onPinDragEnd).toHaveBeenCalledTimes(1);
    expect(onPinDragEnd).toHaveBeenCalledWith('walk-a', 1, [100, 0]);

    // an inactive pin is not draggable: the press goes to the picture
    expect(gone.classList.contains('draggable')).toBe(false);
    pointer(gone, 'pointerdown', 40, 10);
    expect(parentDown).toHaveBeenCalledTimes(1);
  });

  it('without a drag handler pins let the press through (pan, click to pick)', () => {
    const parentDown = vi.fn();
    render(
      <div onPointerDown={parentDown}>
        <WalkSheetOverlay drawings={[drawing()]} scale={2} />
      </div>,
    );
    const pin = host.querySelector('[data-testid="walk-pin"]');
    if (!pin) throw new Error('no pin');
    pointer(pin, 'pointerdown', 0, 0);
    expect(parentDown).toHaveBeenCalled();
  });
});
