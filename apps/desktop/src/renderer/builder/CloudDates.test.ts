import { describe, expect, it, vi } from 'vitest';
import { cloudDateDefault, cloudDayOf } from './CloudDates';

// the card files through the bridge; these tests only read its pure helpers
vi.mock('../shell', () => ({ bridge: {}, shell: {} }));

const captures = [
  { id: 'capture-2026-03-04', date: '2026-03-04', label: 'Survey' },
  { id: 'capture-2026-10-12', date: '2026-10-12', label: 'Survey' },
];

describe('the survey day of a cloud in Add data', () => {
  it('takes the project date of the header day when there is one', () => {
    expect(cloudDateDefault('2026-10-12', captures)).toEqual({
      kind: 'capture',
      id: 'capture-2026-10-12',
    });
  });

  it('offers a new date with the header day filled in when the project has none', () => {
    expect(cloudDateDefault('2026-10-07', captures)).toEqual({ kind: 'new', day: '2026-10-07' });
  });

  it('is Not dated when the file carries no day', () => {
    expect(cloudDateDefault(null, captures)).toEqual({ kind: 'capture', id: '' });
  });

  it('gives main the day of the choice, or null for Not dated', () => {
    expect(cloudDayOf({ kind: 'capture', id: 'capture-2026-03-04' }, captures)).toBe('2026-03-04');
    expect(cloudDayOf({ kind: 'capture', id: '' }, captures)).toBeNull();
    expect(cloudDayOf({ kind: 'new', day: '2026-10-07' }, captures)).toBe('2026-10-07');
    // a new day not filled in yet is not a day
    expect(cloudDayOf({ kind: 'new', day: '' }, captures)).toBeUndefined();
  });
});
