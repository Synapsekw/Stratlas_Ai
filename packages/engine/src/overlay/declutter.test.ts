import { describe, expect, it } from 'vitest';
import { declutter, estimateLabelWidth, formatMetres, FrameStats } from './declutter';

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

  it('ignores idle gaps longer than a second', () => {
    const s = new FrameStats(4);
    for (const t of [0, 16, 2000, 2016]) s.tick(t);
    expect(s.fps()).toBeCloseTo(62.5, 1);
  });
});
