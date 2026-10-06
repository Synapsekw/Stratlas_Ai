import { describe, expect, it } from 'vitest';
import { CHANGE_RAMP_GLSL, changeColour, changeGradient, isNeutral, isWarm } from './changeRamp';

describe('the change ramp', () => {
  it('is grey where nothing moved and red at the far distance', () => {
    expect(isNeutral(changeColour(0, 0.3, false))).toBe(true);
    expect(isNeutral(changeColour(0.01, 0.3, false))).toBe(true);
    expect(isWarm(changeColour(0.3, 0.3, false))).toBe(true);
    expect(isWarm(changeColour(2, 0.3, false))).toBe(true);
    expect(changeColour(0.15, 0.3, false)).toEqual(changeColour(-0.15, 0.3, false));
  });

  it('diverges blue below zero and red above it around grey', () => {
    expect(isNeutral(changeColour(0, 0.3, true))).toBe(true);
    const [r, , b] = changeColour(-0.3, 0.3, true);
    expect(b).toBeGreaterThan(r + 0.3);
    expect(isWarm(changeColour(0.3, 0.3, true))).toBe(true);
  });

  it('gives the legend and the shader the same stops', () => {
    expect(changeGradient(false)).toBe(
      'linear-gradient(to right, #9ca3af 0%, #f5c542 50%, #e2412b 100%)',
    );
    expect(changeGradient(true)).toContain('#3b6ed6 0%');
    expect(CHANGE_RAMP_GLSL).toContain('vec3 changeRamp(float t, float diverging)');
  });
});
