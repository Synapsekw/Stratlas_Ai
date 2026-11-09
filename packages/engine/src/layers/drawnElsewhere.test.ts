import { describe, expect, it } from 'vitest';
import { isDrawnElsewhere } from './drawnElsewhere';

describe('isDrawnElsewhere', () => {
  it('knows flight lines are drawn by the app, so the stage need not warn', () => {
    expect(isDrawnElsewhere('flightline')).toBe(true);
  });
  it('still warns for kinds nothing draws', () => {
    expect(isDrawnElsewhere('vector')).toBe(false);
    expect(isDrawnElsewhere('mesh')).toBe(false);
  });
});
