// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineModel } from './model';
import { tickLabel } from './parts';
import { Timeline, type TimelineProps } from './Timeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  // jsdom has no ResizeObserver; the timeline only needs it to exist
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {
        // no-op
      }
      disconnect() {
        // no-op
      }
      unobserve() {
        // no-op
      }
    };
  }
});
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
});

const T0 = Date.UTC(2026, 0, 5, 7, 0, 0);
const model: TimelineModel = {
  clips: [
    { layerId: 'a', name: 'Clip A', startMs: T0, endMs: T0 + 60_000, estimated: false, group: 'a' },
    {
      layerId: 'b',
      name: 'Clip B',
      startMs: T0 + 120_000,
      endMs: T0 + 180_000,
      estimated: true,
      group: 'b',
    },
  ],
  groups: [
    { id: 'a', name: 'Clip A', startMs: T0, endMs: T0 + 60_000, clips: ['a'] },
    { id: 'b', name: 'Clip B', startMs: T0 + 120_000, endMs: T0 + 180_000, clips: ['b'] },
  ],
  issues: [],
  photos: [],
  captures: [],
  range: [T0 - 3_600, T0 + 183_600],
};
const props = (over: Partial<TimelineProps> = {}): TimelineProps => ({
  model,
  nowMs: T0,
  playing: false,
  rate: 1,
  activeClip: 'a',
  onSeek: vi.fn(),
  onTogglePlay: vi.fn(),
  onRate: vi.fn(),
  onClip: vi.fn(),
  onStep: vi.fn(),
  ...over,
});
const render = (p: TimelineProps) => {
  root = createRoot(host);
  act(() => root?.render(<Timeline {...p} />));
};
const button = (name: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

describe('Timeline', () => {
  it('draws a bar per clip, the active one pressed and the estimated one dashed', () => {
    render(props());
    const bars = [...host.querySelectorAll<HTMLButtonElement>('.seg-c')];
    expect(bars.map((b) => b.title)).toEqual(['Clip A', 'Clip B (length not known yet)']);
    expect(bars[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(bars[1]?.classList.contains('est')).toBe(true);
  });
  it('shows the clock, the rate and the active clip', () => {
    render(props());
    expect(host.querySelector('[data-testid="timecode"]')?.textContent).toBe('07:00:00.00');
    expect(button('Playback rate 1x')?.textContent).toBe('1.0×');
    expect(host.querySelector('.tl-h .tag')?.textContent).toBe('Clip A');
  });
  it('steps clips, plays and cycles the rate through its callbacks', () => {
    const p = props();
    render(p);
    act(() => button('Next clip')?.click());
    act(() => button('Previous clip')?.click());
    act(() => button('Play')?.click());
    act(() => button('Playback rate 1x')?.click());
    expect(p.onStep).toHaveBeenNthCalledWith(1, 1);
    expect(p.onStep).toHaveBeenNthCalledWith(2, -1);
    expect(p.onTogglePlay).toHaveBeenCalledTimes(1);
    expect(p.onRate).toHaveBeenCalledWith(2);
  });
  it('a keyboard click on a clip chooses it without a time', () => {
    const p = props();
    render(p);
    act(() => {
      host
        .querySelectorAll('.seg-c')[1]
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    });
    expect(p.onClip).toHaveBeenCalledWith('b');
  });
  it('draws a playhead and a ruler, and offers hide only with onHide', () => {
    render(props());
    expect(host.querySelector('[data-testid="playhead"]')).not.toBeNull();
    expect(host.querySelectorAll('.tl-ruler .tk').length).toBeGreaterThan(0);
    expect(host.querySelector('.tl-hide')).toBeNull();
  });
  it('says so when nothing carries time', () => {
    render(props({ model: { ...model, clips: [], groups: [], range: null } }));
    expect(host.querySelector('.tl-empty')).not.toBeNull();
    expect(host.querySelector('[data-testid="timecode"]')?.textContent).toBe('--:--:--');
  });
});

describe('tickLabel', () => {
  it('labels days, minutes, seconds and tenths', () => {
    expect(tickLabel(Date.UTC(2026, 0, 5), 86_400_000)).toBe('5/1');
    expect(tickLabel(T0, 60_000)).toBe('07:00');
    expect(tickLabel(T0 + 5_000, 1_000)).toBe('07:00:05');
    expect(tickLabel(T0 + 500, 100)).toBe('07:00:00.5');
  });
});
