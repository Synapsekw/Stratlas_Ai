// @vitest-environment jsdom
import { act, useImperativeHandle, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { splitPrefs } from './prefs';
import { ResizableSplit, type ResizableSplitProps } from './ResizableSplit';
import { useResizableSplit, type SplitOptions } from './useResizableSplit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null = null;
let frames: FrameRequestCallback[] = [];

const flushFrames = () => {
  const run = frames;
  frames = [];
  act(() => {
    for (const f of run) f(0);
  });
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1100,
    bottom: 700,
    width: 1100,
    height: 700,
    toJSON: () => ({}),
  });
  splitPrefs.setState({ byId: {} });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const base: ResizableSplitProps = {
  id: 'test.split',
  label: 'Resize the library',
  orientation: 'horizontal',
  sized: 'start',
  unit: 'px',
  defaultSize: 300,
  min: 200,
  max: '50%',
  otherMin: 360,
  start: <p data-testid="start">start</p>,
  end: <p data-testid="end">end</p>,
};

function render(props: Partial<ResizableSplitProps> = {}) {
  root = createRoot(host);
  act(() => root?.render(<ResizableSplit {...base} {...props} />));
}

const separator = () => {
  const el = host.querySelector<HTMLElement>('[role="separator"]');
  if (!el) throw new Error('no separator');
  return el;
};
const container = () => {
  const el = host.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('no container');
  return el;
};
const size = () => container().style.getPropertyValue('--split-size');

function pointer(type: string, clientX: number, clientY = 100) {
  act(() => {
    separator().dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
        pointerId: 1,
      }),
    );
  });
}

function drag(from: number, to: number) {
  pointer('pointerdown', from);
  pointer('pointermove', from + (to - from) / 2);
  pointer('pointermove', to);
  flushFrames();
  pointer('pointerup', to);
}

const key = (k: string, shiftKey = false) => {
  act(() => {
    separator().dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true }));
  });
};

describe('ResizableSplit', () => {
  it('is a labelled, focusable separator that controls the sized pane', () => {
    render({ sized: 'end' });
    const sep = separator();
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    expect(sep.getAttribute('aria-label')).toBe('Resize the library');
    expect(sep.tabIndex).toBe(0);
    expect(sep.getAttribute('aria-valuenow')).toBe('300');
    expect(sep.getAttribute('aria-valuemin')).toBe('200');
    expect(sep.getAttribute('aria-valuemax')).toBe('550');
    expect(sep.getAttribute('aria-valuetext')).toBe('300 px');
    const controlled = document.getElementById(sep.getAttribute('aria-controls') ?? '');
    expect(controlled?.contains(host.querySelector('[data-testid="end"]'))).toBe(true);
    expect(size()).toBe('300px');
  });

  it('is horizontal for a vertical split', () => {
    render({ orientation: 'vertical' });
    expect(separator().getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('writes the size in an animation frame and saves once, on pointer up', () => {
    render();
    const save = vi.spyOn(splitPrefs.getState(), 'save');
    pointer('pointerdown', 300);
    pointer('pointermove', 320);
    pointer('pointermove', 340);
    expect(size()).toBe('300px');
    flushFrames();
    expect(size()).toBe('340px');
    expect(container().hasAttribute('data-dragging')).toBe(true);
    expect(host.querySelector('.split-readout')?.textContent).toBe('340 px');
    expect(save).not.toHaveBeenCalled();
    pointer('pointerup', 340);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('test.split', { size: 340, collapsed: false });
    expect(size()).toBe('340px');
    expect(container().hasAttribute('data-dragging')).toBe(false);
    expect(separator().getAttribute('aria-valuenow')).toBe('340');
  });

  it('does not save a click without a move', () => {
    render();
    const save = vi.spyOn(splitPrefs.getState(), 'save');
    pointer('pointerdown', 300);
    pointer('pointerup', 300);
    expect(save).not.toHaveBeenCalled();
  });

  it('clamps a drag to the limits', () => {
    render();
    drag(300, 900);
    expect(size()).toBe('550px');
  });

  it('grows the end pane with ArrowLeft, steps 64 with Shift, and goes to min and max', () => {
    render({ sized: 'end' });
    key('ArrowLeft');
    expect(size()).toBe('316px');
    key('ArrowRight', true);
    expect(size()).toBe('252px');
    key('ArrowUp');
    expect(size()).toBe('252px');
    key('Home');
    expect(size()).toBe('200px');
    key('End');
    expect(size()).toBe('550px');
    expect(splitPrefs.getState().byId['test.split']).toEqual({ size: 550, collapsed: false });
  });

  it('resets to the default on double-click and saves', () => {
    splitPrefs.setState({ byId: { 'test.split': { size: 420 } } });
    render();
    expect(size()).toBe('420px');
    const save = vi.spyOn(splitPrefs.getState(), 'save');
    act(() => {
      separator().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(size()).toBe('300px');
    expect(save).toHaveBeenCalledWith('test.split', { size: 300, collapsed: false });
  });

  it('collapses when dragged below the minimum minus 48 px', () => {
    const onCollapsedChange = vi.fn();
    render({ collapsedSize: 12, onCollapsedChange });
    drag(300, 151);
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    expect(size()).toBe('12px');
    expect(container().hasAttribute('data-collapsed')).toBe(true);
    expect(splitPrefs.getState().byId['test.split']).toEqual({ size: 300, collapsed: true });
  });

  it('toggles collapse with Enter', () => {
    const onCollapsedChange = vi.fn();
    render({ collapsedSize: 12, onCollapsedChange });
    key('Enter');
    expect(size()).toBe('12px');
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
    key('Enter');
    expect(size()).toBe('300px');
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
  });

  it('does not collapse a split without a collapsed size', () => {
    render();
    drag(300, 100);
    expect(size()).toBe('200px');
  });

  it('inverts pointer moves in right to left layouts', () => {
    host.setAttribute('dir', 'rtl');
    render();
    drag(800, 760);
    expect(size()).toBe('340px');
  });

  it('writes a fraction as a percentage and saves a fraction', () => {
    render({ unit: 'fraction', defaultSize: 0.5, sized: 'end', max: 800 });
    expect(size()).toBe('50%');
    drag(550, 440);
    expect(size()).toBe('60%');
    expect(splitPrefs.getState().byId['test.split']).toEqual({ size: 0.6, collapsed: false });
  });

  it('follows a controlled collapsed prop', () => {
    render({ collapsedSize: 52, collapsed: true });
    expect(size()).toBe('52px');
    act(() => root?.render(<ResizableSplit {...base} collapsedSize={52} collapsed={false} />));
    expect(size()).toBe('300px');
  });
});

interface HarnessApi {
  toggle: () => void;
  reset: () => void;
}

let renders = 0;
const countRender = () => {
  renders += 1;
};

function Harness({
  options,
  api,
  onRender,
}: {
  options: SplitOptions;
  api: Ref<HarnessApi>;
  onRender: () => void;
}) {
  onRender();
  const { containerRef, separatorProps, toggle, reset } = useResizableSplit(options);
  useImperativeHandle(api, () => ({ toggle, reset }), [toggle, reset]);
  return (
    <div ref={containerRef} className="split">
      <div>a</div>
      <div {...separatorProps} aria-label="Resize" />
      <div>b</div>
    </div>
  );
}

describe('useResizableSplit', () => {
  const options: SplitOptions = {
    id: 'test.hook',
    orientation: 'horizontal',
    sized: 'start',
    unit: 'px',
    defaultSize: 260,
    min: 200,
    max: 600,
    otherMin: 360,
    collapsedSize: 12,
  };

  function mount(o: SplitOptions = options) {
    const api: { current: HarnessApi | null } = { current: null };
    renders = 0;
    root = createRoot(host);
    act(() => root?.render(<Harness options={o} api={api} onRender={countRender} />));
    return { api };
  }

  it('does not render React during pointer moves', () => {
    mount();
    const before = renders;
    pointer('pointerdown', 260);
    for (let x = 266; x < 400; x += 6) pointer('pointermove', x);
    flushFrames();
    expect(size()).toBe('398px');
    expect(renders).toBe(before);
    pointer('pointerup', 398);
    expect(renders).toBeGreaterThan(before);
  });

  it('restores the last size, not the default, on toggle after a drag collapse', () => {
    splitPrefs.setState({ byId: { 'test.hook': { size: 340 } } });
    const { api } = mount();
    drag(340, 120);
    expect(size()).toBe('12px');
    act(() => api.current?.toggle());
    expect(size()).toBe('340px');
    expect(container().hasAttribute('data-collapsed')).toBe(false);
    act(() => api.current?.toggle());
    expect(size()).toBe('12px');
  });
});
