import { describe, expect, it } from 'vitest';
import { dateTags } from './dateTags';

describe('dateTags', () => {
  const tags = dateTags([
    { id: 'nov', date: '2024-11-06' },
    { id: 'sep', date: '2024-09-04' },
    { id: 'oct', date: '2024-10-02' },
  ]);
  it('orders by date regardless of input order', () => {
    expect([tags.sep?.order, tags.oct?.order, tags.nov?.order]).toEqual([0, 1, 2]);
  });
  it('assigns palette colours by order', () => {
    expect(tags.sep?.colour).toBe('var(--date-1)');
    expect(tags.nov?.colour).toBe('var(--date-3)');
  });
  it('short labels drop the year inside one calendar year', () => {
    expect(tags.nov?.short).toBe('6 Nov');
    expect(tags.nov?.long).toBe('6 Nov 2024');
  });
  it('short labels keep a two-digit year across years', () => {
    const t = dateTags([
      { id: 'a', date: '2024-12-30' },
      { id: 'b', date: '2025-01-06' },
    ]);
    expect(t.a?.short).toBe('30 Dec 24');
    expect(t.b?.short).toBe('6 Jan 25');
  });
  it('wraps colours after eight dates', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `d${i}`,
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
    }));
    expect(dateTags(many).d8?.colour).toBe('var(--date-1)');
  });
  it('a picked colour wins over the date order and leaves the other dates alone', () => {
    const t = dateTags([
      { id: 'sep', date: '2024-09-04' },
      { id: 'oct', date: '2024-10-02', colour: 7, icon: 'flag' },
      { id: 'nov', date: '2024-11-06' },
    ]);
    expect(t.oct).toMatchObject({
      colour: 'var(--date-7)',
      colourIndex: 7,
      picked: true,
      icon: 'flag',
    });
    expect(t.sep).toMatchObject({ colour: 'var(--date-1)', colourIndex: 1 });
    expect(t.sep?.picked).toBeUndefined();
    expect(t.sep?.icon).toBeUndefined();
    // the order keeps counting every date, so November keeps the colour it had
    expect(t.nov?.colour).toBe('var(--date-3)');
  });
  it('ignores a colour outside the palette', () => {
    const t = dateTags([
      { id: 'a', date: '2024-09-04', colour: 12 },
      { id: 'b', date: '2024-10-02', colour: 0 },
    ]);
    expect(t.a?.colour).toBe('var(--date-1)');
    expect(t.a?.picked).toBeUndefined();
    expect(t.b?.colour).toBe('var(--date-2)');
  });
});
