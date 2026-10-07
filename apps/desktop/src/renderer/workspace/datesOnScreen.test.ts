import { captureIndex } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { datesOnScreen, pickPhotoSet } from './DatesOnScreen';

const index = captureIndex(threeDates);

describe('datesOnScreen', () => {
  it('lists each date with visible layers of the given kinds, oldest first', () => {
    const hidden = {
      'model-oct': true,
      'clip-sep': true,
      'clip-oct': true,
      'clip-nov': true,
    } as const;
    const out = datesOnScreen(index, hidden, threeDates.layers, ['mesh']);
    expect(out).toEqual([
      { capture: 'sep', layers: ['model-sep'] },
      { capture: 'nov', layers: ['model-nov'] },
    ]);
  });
  it('ignores Every date layers and other kinds', () => {
    expect(datesOnScreen(index, {}, threeDates.layers, ['raster'])).toEqual([]);
  });
});

describe('pickPhotoSet', () => {
  const set = (id: string, capture: string) =>
    ({ kind: 'photos', id, name: id, visible: true, capture, items: [{ id: `${id}-1` }] }) as never;
  const sets = [set('ph-sep', 'sep'), set('ph-nov', 'nov')];
  const m = { ...threeDates, layers: [...threeDates.layers, ...sets] };
  const ix = captureIndex(m);
  it('prefers the focused date', () => {
    expect(pickPhotoSet(sets, {}, ix, 'sep')?.id).toBe('ph-sep');
  });
  it('falls back to any visible set, then any set', () => {
    expect(pickPhotoSet(sets, { 'ph-sep': true }, ix, 'oct')?.id).toBe('ph-nov');
    expect(pickPhotoSet(sets, { 'ph-sep': true, 'ph-nov': true }, ix, 'oct')?.id).toBe('ph-sep');
  });
});
