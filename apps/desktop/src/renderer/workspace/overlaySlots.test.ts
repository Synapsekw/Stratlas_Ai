import { describe, expect, it } from 'vitest';
import { assignSlots, CORNERS, cornersOf, type Corner } from './overlaySlots';

describe('assignSlots', () => {
  it('gives each overlay the first free corner it wants, in the order given', () => {
    const slots = assignSlots([
      { id: 'video', want: ['bl'] },
      { id: 'status', want: ['tl', 'bl'] },
      { id: 'dates', want: ['tl', 'bl', 'tr'] },
      { id: 'basemap', want: ['tr', 'br'] },
    ]);
    expect(Object.fromEntries(slots)).toEqual({
      video: 'bl',
      status: 'tl',
      dates: 'tr',
      basemap: 'br',
    });
  });

  it('never puts two overlays in one corner', () => {
    const all: Corner[] = ['tl', 'tr', 'bl', 'br'];
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `o${String(i)}`, want: all }));
    const taken = [...assignSlots(items).values()].filter((c) => c !== 'hidden');
    expect(new Set(taken).size).toBe(taken.length);
    expect(taken).toHaveLength(4);
  });

  it('hides the overflow: an overlay whose corners are all taken', () => {
    const slots = assignSlots([
      { id: 'video', want: ['br'] },
      { id: 'cursor', want: ['br'] },
      { id: 'status', want: ['tl'] },
      { id: 'notice', want: ['tl'] },
      { id: 'none', want: [] },
    ]);
    expect(slots.get('video')).toBe('br');
    expect(slots.get('cursor')).toBe('hidden');
    expect(slots.get('status')).toBe('tl');
    expect(slots.get('notice')).toBe('hidden');
    expect(slots.get('none')).toBe('hidden');
  });

  it('answers for every overlay, and nothing else', () => {
    const slots = assignSlots([
      { id: 'a', want: ['tr'] },
      { id: 'b', want: ['tr'] },
    ]);
    expect([...slots.keys()]).toEqual(['a', 'b']);
    expect(assignSlots([]).size).toBe(0);
  });

  it('lists the four corners', () => {
    expect(CORNERS).toEqual(['tl', 'tr', 'bl', 'br']);
  });
});

describe('cornersOf', () => {
  const stage = { width: 1000, height: 600 };

  it('is the stage quarter that holds the box, when it stays in it', () => {
    expect(cornersOf({ left: 12, top: 380, width: 300, height: 200 }, stage)).toEqual(['bl']);
    expect(cornersOf({ left: 680, top: 380, width: 300, height: 200 }, stage)).toEqual(['br']);
    expect(cornersOf({ left: 12, top: 60, width: 300, height: 200 }, stage)).toEqual(['tl']);
    expect(cornersOf({ left: 680, top: 60, width: 300, height: 200 }, stage)).toEqual(['tr']);
  });

  it('takes every quarter a wide box reaches into, its centre one first', () => {
    // a 280 px window on a 378 px stage (Volumes in front at 1100 px wide)
    const narrow = { width: 378, height: 604 };
    expect(cornersOf({ left: 12, top: 404, width: 280, height: 190 }, narrow)).toEqual([
      'bl',
      'br',
    ]);
    // a few pixels over the middle line is not reaching in
    expect(cornersOf({ left: 12, top: 380, width: 500, height: 200 }, stage)).toEqual(['bl']);
    // a tall, wide window in the middle takes all four
    expect(cornersOf({ left: 200, top: 100, width: 600, height: 400 }, stage)).toHaveLength(4);
  });

  it('names the corners by the reading direction: right to left, the left edge is the end', () => {
    expect(cornersOf({ left: 12, top: 380, width: 300, height: 200 }, stage, true)).toEqual(['br']);
    expect(cornersOf({ left: 680, top: 60, width: 300, height: 200 }, stage, true)).toEqual(['tl']);
  });
});
