import { describe, expect, it } from 'vitest';
import { createCompareDates, defaultPair, orderPair, type DatedCapture } from './compareDates';

const captures: DatedCapture[] = [
  { capture: 'c', t: 300 },
  { capture: 'undated', t: null },
  { capture: 'a', t: 100 },
  { capture: 'b', t: 200 },
];
const timeOf = (c: string) => captures.find((x) => x.capture === c)?.t ?? null;

describe('defaultPair', () => {
  it('pairs the survey before the focus with the focus', () => {
    expect(defaultPair('c', captures)).toEqual({ from: 'b', to: 'c' });
    expect(defaultPair('b', captures)).toEqual({ from: 'a', to: 'b' });
  });

  it('pairs the first survey with the next one', () => {
    expect(defaultPair('a', captures)).toEqual({ from: 'a', to: 'b' });
  });

  it('falls back to the last two surveys for no focus or an undated focus', () => {
    expect(defaultPair(null, captures)).toEqual({ from: 'b', to: 'c' });
    expect(defaultPair('undated', captures)).toEqual({ from: 'b', to: 'c' });
  });

  it('is null with fewer than two dated surveys', () => {
    expect(
      defaultPair('a', [
        { capture: 'a', t: 1 },
        { capture: 'x', t: null },
      ]),
    ).toBeNull();
  });
});

describe('orderPair', () => {
  it('swaps when from is after to', () => {
    expect(orderPair('c', 'a', timeOf)).toEqual({ from: 'a', to: 'c' });
    expect(orderPair('a', 'c', timeOf)).toEqual({ from: 'a', to: 'c' });
  });
});

describe('compareDates store', () => {
  it('starts off and empty', () => {
    expect(createCompareDates().getState()).toMatchObject({ on: false, from: null, to: null });
  });

  it('turns on with the defaults from the focus', () => {
    const s = createCompareDates();
    s.getState().toggle(defaultPair('c', captures));
    expect(s.getState()).toMatchObject({ on: true, from: 'b', to: 'c' });
    s.getState().toggle();
    expect(s.getState()).toMatchObject({ on: false, from: 'b', to: 'c' });
  });

  it('keeps a pair already chosen when it turns on again', () => {
    const s = createCompareDates();
    s.getState().set('a', 'c', timeOf);
    s.getState().toggle(defaultPair('c', captures));
    expect(s.getState()).toMatchObject({ on: true, from: 'a', to: 'c' });
  });

  it('swaps a pair set the wrong way round', () => {
    const s = createCompareDates();
    s.getState().set('c', 'b', timeOf);
    expect(s.getState()).toMatchObject({ from: 'b', to: 'c' });
  });
});
