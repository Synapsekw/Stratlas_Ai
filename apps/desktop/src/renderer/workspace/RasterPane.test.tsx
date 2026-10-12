// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RasterView, type RasterOverlayContext, type RasterPick } from './RasterPane';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => undefined;
globalThis.ResizeObserver = class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
};

/** An image that "loads" at once at 200 x 100 px (jsdom loads no pictures). */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 200;
  naturalHeight = 100;
  private url = '';
  get src(): string {
    return this.url;
  }
  set src(v: string) {
    this.url = v;
    queueMicrotask(() => this.onload?.());
  }
}

type RasterLayer = Extract<Layer, { kind: 'raster' }>;
const layer: RasterLayer = {
  kind: 'raster',
  id: 'raster-plan',
  name: 'Plan',
  visible: true,
  src: { path: 'drawings/plan.png' },
  role: 'plan',
  format: 'image',
};

// the pane is 400 x 300: the 200 x 100 picture fits at 1.92 px per px, from (8, 54)
const SCALE = 1.92;
const OX = 8;
const OY = 54;
const screen = (px: number, py: number) => ({ x: OX + px * SCALE, y: OY + py * SCALE });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  Element.prototype.setPointerCapture = noop;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(props: {
  pick?: RasterPick;
  overlay?: (c: RasterOverlayContext) => React.ReactNode;
}) {
  await act(async () => {
    root.render(<RasterView projectId="p1" layer={layer} {...props} />);
    await Promise.resolve();
  });
  // the view is fitted once the picture's size is known
  await act(async () => {
    await Promise.resolve();
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

const view = () => {
  const el = host.querySelector('[data-testid="raster-view"]');
  if (!el) throw new Error('no view');
  return el;
};

describe('RasterView picking', () => {
  it('a plain click picks the pixel under it', async () => {
    const onPick = vi.fn();
    await render({ pick: { onPick, marks: [] } });
    const at = screen(50, 25);
    pointer(view(), 'pointerdown', at.x, at.y);
    pointer(view(), 'pointerup', at.x, at.y);
    expect(onPick).toHaveBeenCalledTimes(1);
    const [px] = onPick.mock.calls[0] as [[number, number]];
    expect(px[0]).toBeCloseTo(50, 6);
    expect(px[1]).toBeCloseTo(25, 6);
  });

  it('a press on the fit button is not a point, also when the release reaches the view', async () => {
    const onPick = vi.fn();
    await render({ pick: { onPick, marks: [] } });
    const fitButton = view().querySelector('button.raster-fit');
    if (!fitButton) throw new Error('no fit button');
    const at = screen(50, 25);
    // the view captures the pointer on press, so the release is the view's, not the button's
    pointer(fitButton, 'pointerdown', at.x, at.y);
    pointer(view(), 'pointerup', at.x, at.y);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('marks without onDrag stay out of the pointer (drawings behaviour unchanged)', async () => {
    const onPick = vi.fn();
    await render({ pick: { onPick, marks: [{ x: 10, y: 10, label: '1' }] } });
    const mark = host.querySelector('[data-testid="raster-mark"]');
    expect(mark?.getAttribute('data-mark-index')).toBeNull();
    expect((mark as HTMLElement | null)?.style.pointerEvents).toBe('');
    expect(host.querySelector('.raster-overlay')).toBeNull();
  });

  it('RasterView: dragging a mark calls onDrag, a plain click still picks', async () => {
    const onPick = vi.fn();
    const onDrag = vi.fn();
    await render({
      pick: {
        onPick,
        onDrag,
        marks: [
          { x: 10, y: 10, label: '1' },
          { x: 100, y: 50, label: '2' },
        ],
      },
    });
    const marks = host.querySelectorAll('[data-testid="raster-mark"]');
    const second = marks[1];
    if (!second) throw new Error('no mark');
    expect(second.getAttribute('data-mark-index')).toBe('1');
    // drag mark 2 from (100, 50) to (120, 60): the picture does not pan
    const from = screen(100, 50);
    const to = screen(120, 60);
    pointer(second, 'pointerdown', from.x, from.y);
    pointer(second, 'pointermove', to.x, to.y);
    pointer(second, 'pointerup', to.x, to.y);
    expect(onDrag).toHaveBeenCalled();
    const [index, px] = onDrag.mock.lastCall as [number, [number, number]];
    expect(index).toBe(1);
    expect(px[0]).toBeCloseTo(120, 6);
    expect(px[1]).toBeCloseTo(60, 6);
    expect(onPick).not.toHaveBeenCalled();
    const plane = host.querySelector<HTMLElement>('.raster-plane');
    expect(plane?.style.transform).toContain(`translate(${String(OX)}px, ${String(OY)}px)`);

    // a click on a mark that does not move is still a pick
    onDrag.mockClear();
    pointer(second, 'pointerdown', from.x, from.y);
    pointer(second, 'pointerup', from.x + 1, from.y);
    expect(onDrag).not.toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('keeps a dragged mark on the picture', async () => {
    const onDrag = vi.fn();
    await render({ pick: { onPick: vi.fn(), onDrag, marks: [{ x: 10, y: 10, label: '1' }] } });
    const mark = host.querySelector('[data-testid="raster-mark"]');
    if (!mark) throw new Error('no mark');
    const from = screen(10, 10);
    pointer(mark, 'pointerdown', from.x, from.y);
    pointer(mark, 'pointermove', -500, -500);
    const [, px] = onDrag.mock.lastCall as [number, [number, number]];
    expect(px).toEqual([0, 0]);
  });
});

describe('RasterView overlay', () => {
  it('draws the overlay in the picture with the view scale and maps the screen to pixels', async () => {
    let ctx: RasterOverlayContext | null = null;
    await render({
      overlay: (c) => {
        ctx = c;
        return <svg data-testid="walk-overlay" />;
      },
    });
    const svg = host.querySelector('.raster-plane [data-testid="walk-overlay"]');
    expect(svg).not.toBeNull();
    const c = ctx as RasterOverlayContext | null;
    expect(c?.scale).toBeCloseTo(SCALE, 6);
    const at = screen(30, 40);
    const px = c?.toImage(at.x, at.y, svg ?? document.body) ?? [0, 0];
    expect(px[0]).toBeCloseTo(30, 6);
    expect(px[1]).toBeCloseTo(40, 6);
  });
});
