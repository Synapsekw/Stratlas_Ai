import { describe, expect, it } from 'vitest';
import { parseRange } from './range';

describe('parseRange', () => {
  it('returns null when there is no Range header', () => {
    expect(parseRange(null, 1000)).toBeNull();
  });

  it('parses a closed range', () => {
    expect(parseRange('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 });
  });

  it('parses an open-ended range to the last byte', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range', () => {
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
  });

  it('clamps a suffix longer than the file to the whole file', () => {
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end past the file size', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('is unsatisfiable when the start is at or past the end of the file', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-10', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });

  it('ignores malformed or unsupported ranges (serve the whole file)', () => {
    expect(parseRange('bytes=abc', 1000)).toBeNull();
    expect(parseRange('items=0-10', 1000)).toBeNull();
    expect(parseRange('bytes=10-5', 1000)).toBeNull();
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
  });

  it('tolerates whitespace and an upper case unit', () => {
    expect(parseRange(' Bytes = 10 - 19 ', 1000)).toEqual({ start: 10, end: 19 });
  });
});
