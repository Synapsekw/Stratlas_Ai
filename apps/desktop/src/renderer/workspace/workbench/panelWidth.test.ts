import { describe, expect, it } from 'vitest';
import { panelBandOf, restingRightPx, rightSplit, RIGHT_BANDS } from './panelWidth';

describe('the right panel width per band (D1)', () => {
  it('bands the window at 1440 and 1280 px', () => {
    expect(panelBandOf(1100)).toBe('narrow');
    expect(panelBandOf(1279)).toBe('narrow');
    expect(panelBandOf(1280)).toBe('mid');
    expect(panelBandOf(1439)).toBe('mid');
    expect(panelBandOf(1440)).toBe('wide');
  });

  it('opens at 360, 320 and 300 px, docked below 1280 px', () => {
    expect(restingRightPx('wide', undefined, false)).toBe(360);
    expect(restingRightPx('mid', undefined, false)).toBe(320);
    expect(restingRightPx('narrow', undefined, false)).toBe(300);
  });

  it('remembers a drag per band, kept inside the band', () => {
    expect(rightSplit('mid', false).id).not.toBe(rightSplit('wide', false).id);
    expect(restingRightPx('wide', 450, false)).toBe(450);
    expect(restingRightPx('narrow', 450, false)).toBe(RIGHT_BANDS.narrow.max);
    expect(restingRightPx('narrow', 13, false)).toBe(RIGHT_BANDS.narrow.min);
  });

  it('Expand panel opens at the band widest and leaves the remembered width alone', () => {
    expect(restingRightPx('wide', 360, true)).toBe(520);
    expect(rightSplit('wide', true)).toMatchObject({ min: 520, max: 520 });
    expect(restingRightPx('wide', 360, false)).toBe(360);
  });
});
