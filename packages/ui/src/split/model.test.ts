import { describe, expect, it } from 'vitest';
import {
  SNAP_MARGIN,
  SPLIT_STEP,
  SPLIT_STEP_BIG,
  clampSplit,
  keyStep,
  minPx,
  snapsToCollapse,
} from './model';

const limits = { min: 280, max: 600, otherMin: 360 };

describe('clampSplit', () => {
  it('caps the sized pane at a percentage of the container', () => {
    expect(clampSplit(600, 1100, { min: 280, max: '50%', otherMin: 360 })).toBe(550);
  });

  it('raises a size below the minimum to the minimum', () => {
    expect(clampSplit(100, 1100, limits)).toBe(280);
  });

  it('caps the sized pane so the other pane keeps its minimum', () => {
    expect(clampSplit(700, 1100, limits)).toBe(600);
    expect(clampSplit(700, 900, limits)).toBe(540);
  });

  it('lets the other pane give way only after the sized pane reached its minimum', () => {
    expect(clampSplit(400, 500, limits)).toBe(280);
  });
});

describe('a give-way share', () => {
  const squeeze = { min: 360, max: '80%', otherMin: 200, minShare: 0.6 } as const;

  it('lowers the minimum to its share of a container too small for both minimums', () => {
    expect(minPx(squeeze, 488)).toBeCloseTo(292.8);
    expect(clampSplit(9999, 488, squeeze)).toBeCloseTo(292.8);
    expect(clampSplit(0, 488, squeeze)).toBeCloseTo(292.8);
  });

  it('keeps the minimum where there is room', () => {
    expect(minPx(squeeze, 1000)).toBe(360);
    expect(clampSplit(0, 1000, squeeze)).toBe(360);
    expect(minPx(limits, 488)).toBe(280);
  });
});

describe('snapsToCollapse', () => {
  it('snaps below the minimum minus the snap margin', () => {
    expect(SNAP_MARGIN).toBe(48);
    expect(snapsToCollapse(231, limits)).toBe(true);
    expect(snapsToCollapse(232, limits)).toBe(false);
  });
});

describe('keyStep', () => {
  it('grows the end pane when its edge moves left', () => {
    expect(keyStep('ArrowLeft', false, false, 'end')).toBe(SPLIT_STEP);
    expect(keyStep('ArrowRight', false, false, 'end')).toBe(-SPLIT_STEP);
    expect(keyStep('ArrowLeft', false, false, 'start')).toBe(-SPLIT_STEP);
  });

  it('mirrors left and right in right to left layouts', () => {
    expect(keyStep('ArrowLeft', false, true, 'end')).toBe(-16);
    expect(keyStep('ArrowRight', false, true, 'start')).toBe(-16);
  });

  it('moves the edge down with ArrowDown, whatever the direction', () => {
    expect(keyStep('ArrowDown', false, false, 'start')).toBe(16);
    expect(keyStep('ArrowDown', false, true, 'end')).toBe(-16);
    expect(keyStep('ArrowUp', false, false, 'end')).toBe(16);
  });

  it('takes a big step with Shift', () => {
    expect(SPLIT_STEP_BIG).toBe(64);
    expect(keyStep('ArrowLeft', true, false, 'end')).toBe(64);
  });

  it('maps Home, End and Enter, and ignores other keys', () => {
    expect(keyStep('Home', false, false, 'start')).toBe('min');
    expect(keyStep('End', false, false, 'start')).toBe('max');
    expect(keyStep('Enter', false, false, 'start')).toBe('toggle');
    expect(keyStep('a', false, false, 'start')).toBeNull();
  });
});
