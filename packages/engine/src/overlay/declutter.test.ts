import { describe, expect, it } from 'vitest';
import {
  declutter,
  estimateLabelWidth,
  formatMetres,
  FrameStats,
  placeCallouts,
  plateRect,
  segmentHitsRect,
  type CalloutItem,
} from './declutter';

const label = (id: string, x: number, y: number, priority = 0) => ({
  id,
  x,
  y,
  w: 100,
  h: 30,
  priority,
});

describe('declutter', () => {
  it('expands labels that do not overlap', () => {
    const out = declutter([label('a', 0, 0), label('b', 300, 0)]);
    expect([...out].sort()).toEqual(['a', 'b']);
  });

  it('collapses the lower priority of two overlapping labels to a dot', () => {
    const out = declutter([label('a', 0, 0, 1), label('b', 20, 5, 5)]);
    expect([...out]).toEqual(['b']);
  });

  it('keeps forced labels (selected or hovered) expanded even when they overlap', () => {
    const out = declutter([label('a', 0, 0, 9), label('b', 20, 5, 1)], new Set(['b']));
    expect(out.has('b')).toBe(true);
    expect(out.has('a')).toBe(false);
  });

  it('is stable for many labels and never expands overlapping pairs', () => {
    const items = Array.from({ length: 400 }, (_, i) =>
      label(`n${i}`, (i * 37) % 900, (i * 53) % 500, i % 7),
    );
    const out = declutter(items);
    const placed = items.filter((i) => out.has(i.id));
    for (const a of placed)
      for (const b of placed)
        if (a !== b) {
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap).toBe(false);
        }
  });
});

describe('estimateLabelWidth', () => {
  it('grows with the longest line', () => {
    expect(estimateLabelWidth(['20-T-0001', 'LNG STORAGE TANK'])).toBeGreaterThan(
      estimateLabelWidth(['20-T-0001']),
    );
  });
});

describe('formatMetres', () => {
  it('formats distances in metres with sensible precision', () => {
    expect(formatMetres(0.0123)).toBe('12 mm');
    expect(formatMetres(1.23456)).toBe('1.235 m');
    expect(formatMetres(12.3456)).toBe('12.35 m');
    expect(formatMetres(1234.567)).toBe('1 234.6 m');
  });
});

describe('FrameStats', () => {
  it('reports average frame time and fps over a window', () => {
    const s = new FrameStats(4);
    for (const t of [0, 16, 32, 48, 64]) s.tick(t);
    expect(s.fps()).toBeCloseTo(62.5, 1);
    expect(s.worstMs()).toBe(16);
  });

  it('reports frame time percentiles', () => {
    const s = new FrameStats(100);
    let t = 0;
    s.tick(t);
    // 90 frames of 10 ms, 10 of 30 ms
    for (let i = 0; i < 90; i++) s.tick((t += 10));
    for (let i = 0; i < 10; i++) s.tick((t += 30));
    expect(s.percentileMs(50)).toBe(10);
    expect(s.percentileMs(95)).toBe(30);
    expect(s.count()).toBe(100);
    expect(new FrameStats(4).percentileMs(95)).toBe(0);
  });

  it('ignores idle gaps longer than a second', () => {
    const s = new FrameStats(4);
    for (const t of [0, 16, 2000, 2016]) s.tick(t);
    expect(s.fps()).toBeCloseTo(62.5, 1);
  });
});

const callout = (id: string, ax: number, ay: number, priority = 0): CalloutItem => ({
  id,
  ax,
  ay,
  w: 100,
  h: 30,
  up: 30,
  run: 14,
  priority,
});

describe('placeCallouts', () => {
  it('puts the plate on the right when there is room', () => {
    const { sides } = placeCallouts([callout('a', 100, 200)], { width: 800, height: 600 });
    expect(sides.get('a')).toBe('right');
  });

  it('flips the plate to the left at the right edge of the stage', () => {
    const { sides } = placeCallouts([callout('a', 760, 200)], { width: 800, height: 600 });
    expect(sides.get('a')).toBe('left');
    expect(plateRect(callout('a', 760, 200), 'left').x).toBeGreaterThanOrEqual(0);
  });

  it('hides a callout whose anchor is under other UI, dot included', () => {
    const video = { x: 0, y: 300, w: 400, h: 250 };
    const out = placeCallouts([callout('a', 200, 400)], { keepOut: [video] });
    expect(out.hidden.has('a')).toBe(true);
    expect(out.sides.has('a')).toBe(false);
  });

  it('never lets a plate or leader cross the video window, even when forced', () => {
    // anchor just right of the window: the left plate would cover it, the right one is free
    const video = { x: 0, y: 150, w: 300, h: 200 };
    const out = placeCallouts([callout('a', 320, 220)], {
      keepOut: [video],
      forced: new Set(['a']),
      width: 800,
      height: 600,
    });
    expect(out.sides.get('a')).toBe('right');
    // boxed in on both sides: stays a dot
    const wall = { x: 340, y: 0, w: 400, h: 600 };
    const boxed = placeCallouts([callout('b', 320, 220)], {
      keepOut: [video, wall],
      forced: new Set(['b']),
    });
    expect(boxed.sides.has('b')).toBe(false);
    expect(boxed.hidden.has('b')).toBe(false);
  });

  it('keeps plates off issue pins', () => {
    const pin = { x: 320, y: 160, w: 60, h: 24 };
    const out = placeCallouts([callout('a', 300, 200)], { obstacles: [pin], width: 800 });
    expect(out.sides.get('a')).toBe('left');
  });

  it('expands the higher priority of two colliding callouts and forced ones always', () => {
    const out = placeCallouts([callout('a', 300, 200, 1), callout('b', 304, 204, 5)], {
      width: 800,
    });
    expect(out.sides.has('b')).toBe(true);
    // a finds room on the left
    expect(out.sides.get('a')).toBe('left');
    const crowded = [callout('a', 100, 200, 9), callout('b', 104, 204, 5), callout('c', 0, 200)];
    const forced = placeCallouts(crowded, { forced: new Set(['c']), width: 800 });
    expect(forced.sides.get('c')).toBe('right');
  });
});

describe('segmentHitsRect', () => {
  const r = { x: 10, y: 10, w: 10, h: 10 };
  it('detects crossing, touching and missing segments', () => {
    expect(segmentHitsRect(0, 15, 30, 15, r)).toBe(true);
    expect(segmentHitsRect(0, 0, 9, 9, r)).toBe(false);
    expect(segmentHitsRect(15, 15, 16, 16, r)).toBe(true);
    expect(segmentHitsRect(0, 30, 30, 25, r)).toBe(false);
  });
});
