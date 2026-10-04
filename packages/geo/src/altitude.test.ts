import { describe, expect, it } from 'vitest';
import { projectHeight, summariseSources, takeoffAbsAltitude, type HeightRule } from './altitude';

const datum: HeightRule = { prefer: 'absolute', absOffsetM: 100, takeoffH: 100 };
const relative: HeightRule = { prefer: 'relative', absOffsetM: 0, takeoffH: 107.5 };

describe('projectHeight', () => {
  it('uses absolute altitude plus the datum offset when the rule prefers it', () => {
    // Al-Zour flight 1: relative 113.7, absolute 113.7 + 41.9; plant EL = absolute + 100
    const r = projectHeight({ abs: 155.6, rel: 113.7 }, datum);
    expect(r.source).toBe('absolute');
    expect(r.h).toBeCloseTo(255.6, 9);
  });

  it('uses relative altitude plus the take-off height when the rule prefers it', () => {
    const r = projectHeight({ abs: 155.6, rel: 113.7 }, relative);
    expect(r.source).toBe('relative');
    expect(r.h).toBeCloseTo(221.2, 9);
  });

  it('falls back to the other altitude, then to the take-off height', () => {
    expect(projectHeight({ rel: 20 }, datum)).toEqual({ h: 120, source: 'relative' });
    expect(projectHeight({ abs: 50 }, relative)).toEqual({ h: 50, source: 'absolute' });
    expect(projectHeight({}, relative)).toEqual({ h: 107.5, source: 'none' });
    expect(projectHeight({ abs: Number.NaN }, datum)).toEqual({ h: 100, source: 'none' });
  });
});

describe('summariseSources', () => {
  it('names the common source or mixed', () => {
    expect(summariseSources(['relative', 'relative'])).toBe('relative');
    expect(summariseSources(['relative', 'absolute'])).toBe('mixed');
    expect(summariseSources([])).toBeUndefined();
  });
});

describe('takeoffAbsAltitude', () => {
  it('is the median of absolute minus relative altitude', () => {
    expect(
      takeoffAbsAltitude([
        { abs: 155.6, rel: 113.7 },
        { abs: 156.0, rel: 114.0 },
        { abs: 160, rel: 100 },
        { rel: 3 },
      ]),
    ).toBeCloseTo(42, 9);
    expect(takeoffAbsAltitude([{ abs: 1 }, { rel: 2 }])).toBeNull();
  });
});
