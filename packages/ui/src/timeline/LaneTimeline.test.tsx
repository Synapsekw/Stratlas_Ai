// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LaneTimeline, type LaneTimelineProps } from './LaneTimeline';
import { buildLaneModel, siteMidnightUtc, type LaneIndex } from './lanes';
import type { ClipBar, TimelineModel } from './model';

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

const OFF = 180;
const DATES = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10'];
const at = (d: string, h: number, m = 0) => siteMidnightUtc(d, OFF) + (h * 60 + m) * 60_000;
const clip = (layerId: string, startMs: number): ClipBar => ({
  layerId,
  name: `Clip ${layerId}`,
  startMs,
  endMs: startMs + 600_000,
  estimated: false,
  group: layerId,
});
const d5 = DATES[4] ?? '';
const d6 = DATES[5] ?? '';
const tm: TimelineModel = {
  clips: [clip('e1', at(d5, 9)), clip('f1', at(d6, 9, 5)), clip('f2', at(d6, 9, 30))],
  groups: [],
  issues: [{ issueId: 'i1', code: 'I-1', tMs: at(d6, 9, 6), color: undefined, severity: 1 }],
  photos: [],
  captures: [],
  range: null,
};
const index: LaneIndex = {
  captures: DATES.map((d, i) => ({ id: `d${String(i + 1)}`, label: d, date: d })),
  of: { e1: 'd5', f1: 'd6', f2: 'd6' },
};
const model = buildLaneModel(tm, index, 'd6', OFF);
const props = (over: Partial<LaneTimelineProps> = {}): LaneTimelineProps => ({
  model,
  nowMs: at(d6, 9, 6),
  playing: false,
  rate: 1,
  activeClip: 'f1',
  clockLabel: 'site time ≈ UTC+3',
  onFocusLane: vi.fn(),
  onExpand: vi.fn(),
  onSeek: vi.fn(),
  onClip: vi.fn(),
  onStep: vi.fn(),
  onTogglePlay: vi.fn(),
  onRate: vi.fn(),
  ...over,
});
const render = (p: LaneTimelineProps) => {
  root = createRoot(host);
  act(() => root?.render(<LaneTimeline {...p} />));
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const click = (el: Element | null | undefined, detail = 1) => {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
  });
};

describe('LaneTimeline', () => {
  it('draws the visible dates as labelled lanes, the focused one pressed', () => {
    render(props());
    expect(qa('[data-testid^="lane-label-"]').map((e) => e.dataset.testid)).toEqual([
      'lane-label-d4',
      'lane-label-d5',
      'lane-label-d6',
    ]);
    expect(q('lane-label-d6')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('lane-label-d5')?.getAttribute('aria-pressed')).toBe('false');
    expect(q('lane-timeline')?.getAttribute('aria-label')).toBe('Timeline');
    expect(q('lane-clock')?.textContent).toBe('site time ≈ UTC+3');
  });
  it('focuses a date from its label', () => {
    const p = props();
    render(p);
    click(q('lane-label-d5'));
    expect(p.onFocusLane).toHaveBeenCalledWith('d5');
  });
  it('folds the earlier dates behind a row that expands them', () => {
    const p = props();
    render(p);
    expect(q('lane-fold-earlier')?.textContent).toContain('+3 earlier');
    expect(q('lane-fold-later')).toBeNull();
    click(q('lane-fold-earlier'));
    expect(p.onExpand).toHaveBeenCalledWith('earlier');
  });
  it('a clip click in the focused lane chooses it at the clicked time, no focus change', () => {
    const p = props();
    render(p);
    click(q('lane-d6')?.querySelectorAll('[data-testid="lane-clip"]')[1]);
    // jsdom lays nothing out: the click lands at the axis start, clamped into the clip
    expect(p.onClip).toHaveBeenCalledWith('f2', at(d6, 9, 30));
    expect(p.onFocusLane).not.toHaveBeenCalled();
  });
  it('a keyboard click chooses the clip without a time', () => {
    const p = props();
    render(p);
    click(q('lane-d6')?.querySelector('[data-testid="lane-clip"]'), 0);
    expect(p.onClip).toHaveBeenCalledWith('f1');
  });
  it('a clip click in another lane focuses that date first', () => {
    const p = props();
    render(p);
    click(q('lane-d5')?.querySelector('[data-testid="lane-clip"]'));
    expect(p.onFocusLane).toHaveBeenCalledWith('d5');
    expect(p.onClip).toHaveBeenCalledWith('e1', expect.any(Number));
  });
  it('puts the playhead on the focused lane and ghost lines on the others', () => {
    render(props());
    expect(q('lane-d6')?.querySelector('[data-testid="playhead"]')).not.toBeNull();
    expect(qa('[data-testid="playhead"]')).toHaveLength(1);
    expect(qa('[data-testid="ghost-line"]')).toHaveLength(2);
  });
  it('draws issues only on the focused lane, and an issue click seeks and selects', () => {
    const p = props({ onIssue: vi.fn() });
    render(p);
    const marks = qa('.dia');
    expect(marks).toHaveLength(1);
    click(marks[0]);
    expect(p.onSeek).toHaveBeenCalledWith(at(d6, 9, 6));
    expect(p.onIssue).toHaveBeenCalledWith('i1');
  });
  it('shows the site clock in the timecode and the hide button only with onHide', () => {
    render(props({ onHide: vi.fn(), hideKeys: 'T' }));
    expect(q('timecode')?.textContent).toBe('09:06:00.00');
    expect(host.querySelector('.tl-hide')).not.toBeNull();
  });
  it('keeps photos and issues on a dimmed date without video; its issue focuses that date', () => {
    const d4 = DATES[3] ?? '';
    const withMarks = buildLaneModel(
      {
        ...tm,
        issues: [
          ...tm.issues,
          { issueId: 'i4', code: 'I-4', tMs: at(d4, 10), color: undefined, severity: 2 },
        ],
        photos: [{ layerId: 'p4', photoId: 'ph1', tMs: at(d4, 10, 1) }],
      },
      { ...index, of: { ...index.of, p4: 'd4' } },
      'd6',
      OFF,
    );
    const p = props({ model: withMarks, onIssue: vi.fn() });
    render(p);
    expect(q('lane-d4')?.querySelectorAll('.dia')).toHaveLength(1);
    expect(q('lane-d4')?.querySelectorAll('.tick')).toHaveLength(1);
    // the dimmed date with video still shows only its clips
    expect(q('lane-d5')?.querySelectorAll('.dia, .tick')).toHaveLength(0);
    click(q('lane-d4')?.querySelector('.dia'));
    expect(p.onFocusLane).toHaveBeenCalledWith('d4');
    expect(p.onSeek).toHaveBeenCalledWith(at(d4, 10));
    expect(p.onIssue).toHaveBeenCalledWith('i4');
  });
  it('a click on an overlapping sub-row chooses that bar, not the earliest clip', () => {
    const overlap = buildLaneModel(
      { ...tm, clips: [clip('g1', at(d6, 9)), clip('g2', at(d6, 9, 2))] },
      { ...index, of: { g1: 'd6', g2: 'd6' } },
      'd6',
      OFF,
    );
    const p = props({ model: overlap, activeClip: null });
    render(p);
    const bars = q('lane-d6')?.querySelectorAll<HTMLElement>('[data-testid="lane-clip"]');
    expect(bars?.[1]?.style.getPropertyValue('--row')).toBe('1');
    click(bars?.[1]);
    expect(p.onClip).toHaveBeenCalledWith('g2', at(d6, 9, 2));
  });
});
