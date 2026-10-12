import type { WalkPin } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { lastT, loadRaw, noDrawings, pinAtTruth } from '../__fixtures__/walk';
import { fitWalk } from './fit';
import { walkBadgeText, walkQuality } from './quality';

const raw = loadRaw('synthetic');
const broken = loadRaw('broken');
const end = lastT(raw);
const fitOf = (pins: WalkPin[], r = raw) => fitWalk(r, { pins, yawOffsetDeg: 0 }, noDrawings, end);
const mss = (s: number) =>
  `${String(Math.floor(s / 60))}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

describe('walkQuality', () => {
  it('two pins on the truth are good', () => {
    expect(walkQuality(fitOf([pinAtTruth(raw, 4), pinAtTruth(raw, end)]))).toBe('good');
  });
  it('a residual of 0.6 m asks for a check', () => {
    expect(
      walkQuality(fitOf([pinAtTruth(raw, 4), pinAtTruth(raw, 30, [0.6, 0]), pinAtTruth(raw, end)])),
    ).toBe('check');
  });
  it('a residual of 2.5 m is poor', () => {
    expect(
      walkQuality(fitOf([pinAtTruth(raw, 4), pinAtTruth(raw, 30, [2.5, 0]), pinAtTruth(raw, end)])),
    ).toBe('poor');
  });
  it('one pin is unplaced, so is a refusal', () => {
    expect(walkQuality(fitOf([pinAtTruth(raw, 4)]))).toBe('unplaced');
    expect(walkQuality(fitOf([pinAtTruth(raw, 4), pinAtTruth(raw, 6)]))).toBe('unplaced');
  });
  it('a gap asks for a check', () => {
    expect(walkQuality(fitOf([pinAtTruth(broken, 4), pinAtTruth(broken, 25)], broken))).toBe(
      'check',
    );
  });
  it('pins-only asks for a check', () => {
    const pins: WalkPin[] = [
      { t: 0, surface: '@model', at: [0, 0] },
      { t: end, surface: '@model', at: [40, 0] },
    ];
    expect(walkQuality(fitWalk(null, { pins, yawOffsetDeg: 0 }, noDrawings, end))).toBe('check');
  });
  it('an inactive pin asks for a check', () => {
    expect(
      walkQuality(
        fitOf([pinAtTruth(raw, 4), pinAtTruth(raw, end), { t: 30, surface: 'gone', at: [0, 0] }]),
      ),
    ).toBe('check');
  });
});

describe('walkBadgeText', () => {
  it('names the break in m:ss', () => {
    const fit = fitOf([pinAtTruth(broken, 4), pinAtTruth(broken, 25)], broken);
    expect(walkBadgeText(fit, mss)).toBe('Path broken 0:30 to 1:02: add a pin after the gap');
  });
  it('shows the refusal, and nothing for a good walk', () => {
    expect(walkBadgeText(fitOf([pinAtTruth(raw, 4), pinAtTruth(raw, 6)]), mss)).toMatch(
      /at least 5 m/,
    );
    expect(walkBadgeText(fitOf([pinAtTruth(raw, 4), pinAtTruth(raw, end)]), mss)).toBeNull();
  });
});
