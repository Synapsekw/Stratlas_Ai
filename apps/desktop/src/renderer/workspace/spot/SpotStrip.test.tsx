// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpotStrip } from './SpotStrip';
import type { SpotHistory, SpotMatch } from './spotTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const m = (capture: string, photo: string, kind: SpotMatch['kind'] = 'photo'): SpotMatch => ({
  capture,
  kind,
  item: { kind: 'photo', layer: `photos-${capture}`, photo },
  distanceM: 1,
  angleDeg: 0,
  score: 1,
  aerial: kind === 'drone',
});
const history: SpotHistory = {
  spot: { camera: [0, 1.6, 0], bearingDeg: 0, target: [0, 0, -15], aerial: false },
  dates: [
    { capture: 'd1', matches: [m('d1', 'a')], skipped: 0 },
    { capture: 'd2', matches: [], skipped: 2 },
    { capture: 'd3', matches: [m('d3', 'b'), m('d3', 'c', 'drone')], skipped: 0 },
  ],
};
const tags = {
  d1: { id: 'd1', date: '2025-01-01', order: 0, colour: 'red', short: '1 Jan', long: '1 Jan 2025' },
  d2: {
    id: 'd2',
    date: '2025-02-01',
    order: 1,
    colour: 'green',
    short: '1 Feb',
    long: '1 Feb 2025',
  },
  d3: {
    id: 'd3',
    date: '2025-03-01',
    order: 2,
    colour: 'blue',
    short: '1 Mar',
    long: '1 Mar 2025',
  },
} as unknown as Parameters<typeof SpotStrip>[0]['tags'];

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
});
const render = (p: Partial<Parameters<typeof SpotStrip>[0]> = {}) => {
  const onPick = vi.fn();
  act(() => {
    root = createRoot(host);
    root.render(
      <SpotStrip
        history={history}
        at={{ capture: 'd1', i: 0 }}
        tags={tags}
        origin="photo"
        thumb={() => <i />}
        onPick={onPick}
        {...p}
      />,
    );
  });
  return onPick;
};
const slot = (c: string) => host.querySelector(`[data-testid="spot-slot-${c}"]`);
const key = (k: string) => {
  act(() => {
    host
      .querySelector('[data-testid="spot-strip"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};

describe('SpotStrip', () => {
  it('shows one slot per date, oldest first, with the date colour and kind', () => {
    render();
    expect(
      [...host.querySelectorAll('[data-testid^="spot-slot-"]')].map((e) =>
        e.getAttribute('data-capture'),
      ),
    ).toEqual(['d1', 'd2', 'd3']);
    expect(slot('d1')?.getAttribute('aria-selected')).toBe('true');
    expect(slot('d1')?.textContent).toContain('Photo');
  });
  it('shows an empty, hatched slot with the reason and the skipped count', () => {
    render();
    expect(slot('d2')?.getAttribute('data-empty')).toBe('true');
    expect(slot('d2')?.textContent).toContain('Nothing within 15 m');
    expect(slot('d2')?.getAttribute('title')).toContain('2 items without a position were left out');
  });
  it('says "not seen" for an aerial spot and names 25 m for a 360', () => {
    render({ history: { ...history, spot: { ...history.spot, aerial: true } } });
    expect(slot('d2')?.textContent).toContain('Not seen');
    act(() => root?.unmount());
    render({ origin: 'pano' });
    expect(slot('d2')?.textContent).toContain('Nothing within 25 m');
  });
  it('shows "+n" for more images of a date', () => {
    render();
    expect(slot('d3')?.textContent).toContain('+1');
    expect(slot('d1')?.textContent).not.toContain('+');
  });
  it('steps with the arrow keys, skipping empty dates', () => {
    const onPick = render();
    key('ArrowRight');
    expect(onPick).toHaveBeenLastCalledWith({ capture: 'd3', i: 0 });
  });
  it('cycles images of a date with up and down', () => {
    const onPick = render({ at: { capture: 'd3', i: 0 } });
    key('ArrowDown');
    expect(onPick).toHaveBeenLastCalledWith({ capture: 'd3', i: 1 });
  });
  it('jumps to a clicked slot; an empty slot does nothing', () => {
    const onPick = render();
    act(() => {
      (slot('d3') as HTMLElement | null)?.click();
    });
    expect(onPick).toHaveBeenLastCalledWith({ capture: 'd3', i: 0 });
    onPick.mockClear();
    act(() => {
      (slot('d2') as HTMLElement | null)?.click();
    });
    expect(onPick).not.toHaveBeenCalled();
  });
  it('names the current slot for screen readers and includes the skipped count', () => {
    render({ at: { capture: 'd3', i: 0 } });
    const strip = host.querySelector('[data-testid="spot-strip"]');
    const id = strip?.getAttribute('aria-activedescendant');
    expect(id).toBeTruthy();
    expect(slot('d3')?.id).toBe(id);
    expect(slot('d2')?.getAttribute('aria-label')).toContain('Nothing within 15 m');
    expect(slot('d2')?.getAttribute('aria-label')).toContain('2 items without a position');
  });
  it('scrolls the current slot into view when the date changes', () => {
    const scroll = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scroll;
    try {
      render({ at: { capture: 'd1', i: 0 } });
      scroll.mockClear();
      act(() => {
        root?.render(
          <SpotStrip
            history={history}
            at={{ capture: 'd3', i: 0 }}
            tags={tags}
            origin="photo"
            thumb={() => <i />}
            onPick={vi.fn()}
          />,
        );
      });
      expect(scroll).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});
