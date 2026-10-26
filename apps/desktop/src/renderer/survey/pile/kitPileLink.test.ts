// @vitest-environment jsdom
import type { SurveyMeasurement } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { connectKitPilePick, shownKitPiles } from './kitPileLink';

const pile = (id: string, kitPile?: string): SurveyMeasurement => ({
  id,
  family: 'polygon',
  tool: 'volume',
  label: id,
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-24T00:00:00Z',
  ...(kitPile ? { origin: { kind: 'kit-pile' as const, pile: kitPile } } : {}),
});

describe('connectKitPilePick', () => {
  const setup = () => {
    const vol = createStore<{ selected: string | null }>()(() => ({ selected: null }));
    const open = vi.fn<(id: string) => void>();
    const measurements = [pile('m-a', 'Pile 1'), pile('m-b'), pile('m-c', 'Pile 3')];
    const off = connectKitPilePick({ vol, measurements: () => measurements, open });
    return { vol, open, off };
  };

  it('a kit pile pick opens its converted measurement', () => {
    const { vol, open, off } = setup();
    vol.setState({ selected: 'Pile 3' });
    expect(open).toHaveBeenCalledWith('m-c');
    off();
  });

  it('a kit pile with no measurement, or a cleared selection, opens nothing', () => {
    const { vol, open, off } = setup();
    vol.setState({ selected: 'Pile 9' });
    vol.setState({ selected: null });
    expect(open).not.toHaveBeenCalled();
    off();
  });

  it('only a change of the selected pile counts, and the detach stops it', () => {
    const { vol, open, off } = setup();
    vol.setState({ selected: 'Pile 1' });
    vol.setState({ selected: 'Pile 1' });
    expect(open).toHaveBeenCalledTimes(1);
    off();
    vol.setState({ selected: 'Pile 3' });
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('shownKitPiles', () => {
  const m = (id: string, pile?: string): SurveyMeasurement =>
    ({
      id,
      tool: 'volume',
      family: 'polygon',
      ...(pile ? { origin: { kind: 'kit-pile', pile } } : {}),
    }) as unknown as SurveyMeasurement;

  it('names the kit piles whose measurement is on screen, once each', () => {
    expect(shownKitPiles([m('a', 'P02'), m('b'), m('c', 'P01'), m('d', 'P01')])).toEqual([
      'P01',
      'P02',
    ]);
    // hidden or on another date: not among the drawn ones, so its kit body stays
    expect(shownKitPiles([])).toEqual([]);
  });
});
