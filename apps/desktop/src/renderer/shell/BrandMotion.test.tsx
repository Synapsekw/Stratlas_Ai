// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrandLoader, BrandMotion } from './BrandMotion';
import { frameAt, getMotion, restFrame, STROKE } from './brandMotionEngine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
});

function render(ui: ReactElement) {
  root ??= createRoot(host);
  const rerender = (next: ReactElement) => {
    act(() => root?.render(next));
  };
  rerender(ui);
  return {
    container: host,
    rerender,
    unmount: () => {
      act(() => root?.unmount());
      root = undefined;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
});

describe('BrandMotion', () => {
  it('renders four pieces in order, the tail last, coloured by class', () => {
    const { container } = render(<BrandMotion motion="stepOut" still label="Quadrion AI" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Quadrion AI');
    const groups = [...container.querySelectorAll('g[data-piece]')];
    expect(groups.map((g) => g.getAttribute('data-piece'))).toEqual(['0', '1', '2', '3']);
    expect(groups[0]?.querySelector('.bm-shape')?.classList.contains('mark-piece')).toBe(true);
    expect(groups[3]?.querySelector('.bm-shape')?.classList.contains('mark-tail')).toBe(true);
    // no inline colour: the theme decides
    for (const p of container.querySelectorAll('path')) expect(p.getAttribute('fill')).toBeNull();
  });

  it('stands at rest when still, and says so at once', () => {
    const done = vi.fn();
    const { container } = render(<BrandMotion motion="sequence" still onDone={done} />);
    const shapes = [...container.querySelectorAll('.bm-shape')].map((p) => p.getAttribute('d'));
    expect(shapes).toEqual(restFrame().map((p) => p.d));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('does not move under reduced motion', () => {
    document.documentElement.dataset.motion = 'reduce';
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = render(<BrandLoader />);
    expect(raf).not.toHaveBeenCalled();
    expect(container.querySelector('.bm-shape')?.getAttribute('d')).toBe(restFrame()[0]?.d);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('sizes the loader as brand-loader unless the caller gives it a class', () => {
    const { container, rerender } = render(<BrandLoader />);
    expect(container.querySelector('svg')?.getAttribute('class')).toBe('bm brand-loader');
    rerender(<BrandLoader className="pc-loader" />);
    expect(container.querySelector('svg')?.getAttribute('class')).toBe('bm pc-loader');
  });

  it('stops its frame loop when it unmounts', () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const { unmount } = render(<BrandMotion motion="turns" loop />);
    unmount();
    expect(cancel).toHaveBeenCalled();
  });

  it('jumps to rest when still turns on mid-play', () => {
    const { container, rerender } = render(<BrandMotion motion="stepOut" />);
    rerender(<BrandMotion motion="stepOut" still />);
    expect(container.querySelectorAll('.bm-shape')[3]?.getAttribute('d')).toBe(restFrame()[3]?.d);
  });
});

/** Frames by hand: `at(ms)` runs the frame the component asked for, at that time. */
function frames() {
  let pending: FrameRequestCallback | undefined;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    pending = cb;
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
    pending = undefined;
  });
  return {
    at(ms: number) {
      const cb = pending;
      pending = undefined;
      cb?.(ms);
    },
    waiting: () => pending !== undefined,
  };
}
const shape = (i: number) => host.querySelectorAll('.bm-shape')[i];
const halo = (i: number) => host.querySelectorAll<SVGPathElement>('.bm-halo')[i];
const rest = (i: number) => restFrame()[i]?.d;

describe('BrandMotion, frame by frame', () => {
  it('fills the box its class gives it: the view box is the square of the mark', () => {
    render(<BrandMotion motion="sequence" still className="lockup-mark" />);
    const svg = host.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('4 4 52 52');
    expect(svg?.getAttribute('class')).toBe('bm lockup-mark');
  });

  it('starts on the first frame of its motion, never on a flash of the finished mark', () => {
    const ring = frameAt(getMotion('stepOut'), 0).pieces[3]?.d ?? '';
    expect(ring).not.toBe(rest(3));
    // the markup itself, before any effect or frame has run
    const markup = renderToStaticMarkup(<BrandMotion motion="stepOut" />);
    expect(markup).toContain(`d="${ring}"`);
    expect(markup).not.toContain(`d="${rest(3) ?? ''}"`);
    // and mounted, before the first frame comes
    const clock = frames();
    render(<BrandMotion motion="stepOut" />);
    expect(clock.waiting()).toBe(true);
    expect(shape(3)?.getAttribute('d')).toBe(ring);
    expect(shape(3)?.getAttribute('d')).not.toBe(rest(3));
    expect(shape(0)?.getAttribute('d')).toBe(rest(0));
  });

  it('renders the mark itself where it will not play', () => {
    const whole = restFrame().map((p) => `d="${p.d}"`);
    for (const d of whole)
      expect(renderToStaticMarkup(<BrandMotion motion="stepOut" still />)).toContain(d);
    document.documentElement.dataset.motion = 'reduce';
    for (const d of whole)
      expect(renderToStaticMarkup(<BrandMotion motion="stepOut" />)).toContain(d);
  });

  it('shows the right first frame when still or the motion changes after mount', () => {
    const clock = frames();
    const ring = frameAt(getMotion('stepOut'), 0).pieces[3]?.d;
    const { rerender } = render(<BrandMotion motion="stepOut" still />);
    expect(shape(3)?.getAttribute('d')).toBe(rest(3));
    expect(clock.waiting()).toBe(false);
    // released: back to the closed ring, before any frame
    rerender(<BrandMotion motion="stepOut" />);
    expect(shape(3)?.getAttribute('d')).toBe(ring);
    expect(clock.waiting()).toBe(true);
    // part of the way, then another motion: its own first frame, which is the mark
    clock.at(0);
    clock.at(600);
    expect(shape(3)?.getAttribute('d')).not.toBe(ring);
    rerender(<BrandMotion motion="sequence" />);
    expect(shape(3)?.getAttribute('d')).toBe(rest(3));
    // a turning loader that becomes Step out loses its turn at once
    rerender(<BrandMotion motion="turns" loop />);
    clock.at(0);
    clock.at(300);
    expect(shape(3)?.hasAttribute('transform')).toBe(true);
    rerender(<BrandMotion motion="stepOut" />);
    expect(shape(3)?.hasAttribute('transform')).toBe(false);
    expect(shape(3)?.getAttribute('d')).toBe(ring);
    // and the same motion again after it has ended starts from its first frame
    clock.at(0);
    clock.at(980);
    expect(shape(3)?.getAttribute('d')).toBe(rest(3));
    rerender(<BrandMotion motion="sequence" />);
    rerender(<BrandMotion motion="stepOut" />);
    expect(shape(3)?.getAttribute('d')).toBe(ring);
  });

  it('plays one pass, comes to rest and says so once', () => {
    const clock = frames();
    const done = vi.fn();
    render(<BrandMotion motion="stepOut" onDone={done} />);
    clock.at(1000);
    expect(shape(3)?.getAttribute('d')).not.toBe(rest(3));
    expect(shape(0)?.getAttribute('d')).toBe(rest(0));
    clock.at(1500);
    expect(done).not.toHaveBeenCalled();
    clock.at(1980);
    expect(shape(3)?.getAttribute('d')).toBe(rest(3));
    expect(done).toHaveBeenCalledTimes(1);
    expect(clock.waiting()).toBe(false);
  });

  it('does not start again when only onDone changes', () => {
    const clock = frames();
    const done = vi.fn();
    const { rerender } = render(<BrandMotion motion="stepOut" onDone={vi.fn()} />);
    clock.at(0);
    clock.at(500);
    const midway = shape(3)?.getAttribute('d');
    rerender(<BrandMotion motion="stepOut" onDone={done} />);
    expect(shape(3)?.getAttribute('d')).toBe(midway);
    clock.at(980);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('plays a single pass again after a rest when it loops', () => {
    const clock = frames();
    const done = vi.fn();
    render(<BrandMotion motion="stepOut" loop onDone={done} />);
    clock.at(0);
    clock.at(980);
    expect(shape(3)?.getAttribute('d')).toBe(rest(3));
    clock.at(980 + 2399);
    expect(shape(3)?.getAttribute('d')).toBe(rest(3));
    clock.at(980 + 2400);
    expect(shape(3)?.getAttribute('d')).not.toBe(rest(3));
    clock.at(980 + 2400 + 980);
    expect(shape(3)?.getAttribute('d')).toBe(rest(3));
    expect(done).toHaveBeenCalledTimes(1);
    expect(clock.waiting()).toBe(true);
  });

  it('turns the two paths of a piece and leaves its group alone', () => {
    const clock = frames();
    render(<BrandLoader />);
    clock.at(0);
    expect(shape(0)?.hasAttribute('transform')).toBe(false);
    clock.at(300);
    expect(shape(0)?.getAttribute('transform')).toMatch(/^rotate\(\d+(\.\d+)? 29 29\)$/);
    expect(halo(0)?.getAttribute('transform')).toBe(shape(0)?.getAttribute('transform'));
    for (const g of host.querySelectorAll('g[data-piece]'))
      expect(g.hasAttribute('transform')).toBe(false);
    // a full turn is no turn
    clock.at(4 * 855);
    expect(shape(3)?.hasAttribute('transform')).toBe(false);
    expect(clock.waiting()).toBe(true);
  });

  it('does not rewrite an attribute that has not changed from one frame to the next', () => {
    const clock = frames();
    render(<BrandLoader />);
    clock.at(0);
    // the turns motion only turns the pieces: the outline stays the same from frame to frame
    const tail = shape(3) as SVGPathElement;
    const write = vi.spyOn(tail, 'setAttribute');
    for (const ms of [100, 200, 300]) clock.at(ms);
    const names = write.mock.calls.map(([name]) => name);
    // the spy sees the frames (the angle is written) but not a single unchanged outline
    expect(names).toContain('transform');
    expect(names).not.toContain('d');
    expect(tail.getAttribute('d')).toBe(rest(3));
  });

  it('shows the halo only where a form has one', () => {
    const clock = frames();
    render(<BrandMotion motion="sequence" />);
    expect(halo(3)?.style.display).toBe('none');
    clock.at(0);
    expect(halo(3)?.style.display).toBe('none');
    // on the model form
    clock.at(685 + 360 + 685);
    expect(halo(3)?.style.display).toBe('');
    expect(halo(3)?.getAttribute('d')).toBe(shape(3)?.getAttribute('d'));
    expect(Number(halo(3)?.getAttribute('stroke-width'))).toBeCloseTo(STROKE + 4.4);
    expect(Number(shape(1)?.getAttribute('opacity'))).toBeCloseTo(0.5);
    clock.at(4865);
    expect(halo(3)?.style.display).toBe('none');
    expect(Number(shape(1)?.getAttribute('opacity'))).toBe(1);
  });

  it('waits while the window is hidden and carries on from where it stopped', () => {
    const clock = frames();
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    render(<BrandMotion motion="sequence" />);
    clock.at(0);
    clock.at(400);
    const before = shape(0)?.getAttribute('d');
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(clock.waiting()).toBe(false);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    clock.at(60_000);
    expect(shape(0)?.getAttribute('d')).toBe(before);
    clock.at(60_100);
    expect(shape(0)?.getAttribute('d')).not.toBe(before);
  });

  it('comes to rest when reduced motion turns on mid-play', () => {
    const clock = frames();
    const done = vi.fn();
    const { rerender } = render(<BrandMotion motion="turns" loop onDone={done} />);
    clock.at(0);
    clock.at(300);
    expect(shape(0)?.hasAttribute('transform')).toBe(true);
    document.documentElement.dataset.motion = 'reduce';
    clock.at(316);
    expect(shape(0)?.hasAttribute('transform')).toBe(false);
    expect(shape(0)?.getAttribute('d')).toBe(rest(0));
    expect(done).toHaveBeenCalledTimes(1);
    expect(clock.waiting()).toBe(false);
    // a later render finds it standing still and does not say so a second time
    rerender(<BrandMotion motion="turns" loop onDone={done} />);
    expect(done).toHaveBeenCalledTimes(1);
    expect(clock.waiting()).toBe(false);
    // and it plays again once motion is allowed and it renders
    delete document.documentElement.dataset.motion;
    rerender(<BrandMotion motion="turns" loop onDone={done} />);
    expect(clock.waiting()).toBe(true);
  });
});
