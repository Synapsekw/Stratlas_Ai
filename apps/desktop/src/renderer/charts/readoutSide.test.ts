import { describe, expect, it } from 'vitest';
import { READOUT_W, readoutFlips } from './readoutSide';

const chart = { left: 40, plotW: 500, w: 560, gap: 10, cardW: READOUT_W };
/** The card's span on x for a placement, as the charts lay it out. */
const span = (x: number, flip: boolean): [number, number] =>
  flip
    ? [x - chart.gap - chart.cardW, x - chart.gap]
    : [x + chart.gap, x + chart.gap + chart.cardW];
const covers = (x: number, flip: boolean, lastX: number) => {
  const [a, b] = span(x, flip);
  return lastX + 6 > a && lastX - 6 < b;
};

describe('readoutFlips', () => {
  it('tooltip never covers the last point', () => {
    const lastX = chart.left + chart.plotW;
    for (let x = chart.left; x <= lastX; x += 5) {
      const flip = readoutFlips({ ...chart, x, lastX });
      expect(covers(x, flip, lastX), `at ${String(x)}`).toBe(false);
    }
  });

  it('keeps the half-way rule when the last point is not in the way', () => {
    expect(readoutFlips({ ...chart, x: 100, lastX: 540 })).toBe(false);
    expect(readoutFlips({ ...chart, x: 500, lastX: 540 })).toBe(true);
  });

  it('stays inside the chart when it can', () => {
    // the newest point near the start: right of it would leave the chart, left of it covers nothing
    expect(readoutFlips({ ...chart, x: 520, lastX: 60 })).toBe(true);
  });
});
