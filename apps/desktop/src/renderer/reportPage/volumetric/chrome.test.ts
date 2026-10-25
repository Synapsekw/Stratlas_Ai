import { describe, expect, it } from 'vitest';
import { num, signed } from './chrome';

describe('volumetric number formats', () => {
  it('keeps the minus on a negative volume', () => {
    expect(num(-200)).toBe('−200');
    expect(num(-42.25)).toBe('−42.3');
    expect(num(1131)).toBe('1,131');
  });

  it('signed does not double the sign', () => {
    expect(signed(-200, ' m³')).toBe('−200 m³');
    expect(signed(5, ' m³')).toBe('+5.0 m³');
  });
});
