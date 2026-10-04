import { describe, expect, it } from 'vitest';
import { f0, f1, sgn } from './format';

describe('volume formatting', () => {
  it('rounds to whole cubic metres with thousands separators', () => {
    expect(f0(11379.4)).toBe('11,379');
    expect(f0(null)).toBe('·');
    expect(f0(Number.NaN)).toBe('·');
  });

  it('signs changes with a true minus', () => {
    expect(sgn(-4383.2)).toBe('−4,383');
    expect(sgn(89)).toBe('+89');
    expect(sgn(0.2)).toBe('0');
  });

  it('keeps one decimal', () => {
    expect(f1(9.64)).toBe('9.6');
  });
});
