import { describe, expect, it } from 'vitest';
import {
  assignSlots,
  CORNER_OF,
  CORNERS,
  cornersOf,
  newest,
  placeOverlays,
  SLOT_OF,
  STAGE_SLOTS,
  type Corner,
} from './overlaySlots';

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

describe('the D5 slots', () => {
  it('only five slots', () => {
    expect(STAGE_SLOTS).toEqual([
      'top-centre',
      'top-right',
      'bottom-left',
      'bottom-right',
      'floating',
    ]);
    expect(new Set(Object.values(SLOT_OF)).size).toBeLessThanOrEqual(5);
    for (const slot of Object.values(SLOT_OF)) expect(STAGE_SLOTS).toContain(slot);
  });

  it('puts each overlay in the slot the design gives it, and nothing at the top left', () => {
    expect(SLOT_OF.island).toBe('top-centre');
    expect(SLOT_OF.mapStyle).toBe('top-right');
    expect(SLOT_OF.hint).toBe('bottom-left');
    expect(SLOT_OF.toast).toBe('bottom-left');
    expect(SLOT_OF.legend).toBe('bottom-right');
    expect(SLOT_OF.video).toBe('floating');
    expect(Object.values(CORNER_OF)).not.toContain('tl');
  });

  it('has no slot for job progress: that is the Jobs chip', () => {
    expect(Object.keys(SLOT_OF)).not.toContain('jobs');
  });

  it('hint and toast share bottom-left, newest wins', () => {
    const older = placeOverlays([
      { id: 'hint', overlay: 'hint', since: 1 },
      { id: 'toast', overlay: 'toast', since: 2 },
    ]);
    expect(older.get('toast')).toBe('bl');
    expect(older.get('hint')).toBe('hidden');
    const newer = placeOverlays([
      { id: 'hint', overlay: 'hint', since: 3 },
      { id: 'toast', overlay: 'toast', since: 2 },
    ]);
    expect(newer.get('hint')).toBe('bl');
    expect(newer.get('toast')).toBe('hidden');
    // a tie goes to the later one in the list
    expect(
      placeOverlays([
        { id: 'a', overlay: 'hint', since: 5 },
        { id: 'b', overlay: 'hint', since: 5 },
      ]).get('b'),
    ).toBe('bl');
  });

  it('stacks the other slots: the top right and the bottom right hold several', () => {
    const slots = placeOverlays([
      { id: 'map', overlay: 'mapStyle' },
      { id: 'dates', overlay: 'dates' },
      { id: 'cf', overlay: 'legend' },
      { id: 'rf', overlay: 'legend' },
    ]);
    expect(Object.fromEntries(slots)).toEqual({ map: 'tr', dates: 'tr', cf: 'br', rf: 'br' });
  });

  it('hides what stands in a corner the floating video or the island takes', () => {
    const slots = placeOverlays(
      [
        { id: 'map', overlay: 'mapStyle' },
        { id: 'hint', overlay: 'hint', since: 1 },
        { id: 'cf', overlay: 'legend' },
      ],
      new Set<Corner>(['bl', 'tr']),
    );
    expect(Object.fromEntries(slots)).toEqual({ map: 'hidden', hint: 'hidden', cf: 'br' });
  });

  it('shows one hint at a time in each corner a split gives them (the newest)', () => {
    const slots = placeOverlays([
      { id: 'stageHint', overlay: 'hint', since: 1, at: 'br' },
      { id: 'volHint', overlay: 'hint', since: 2, at: 'br' },
    ]);
    expect(slots.get('volHint')).toBe('br');
    expect(slots.get('stageHint')).toBe('hidden');
    // one in another corner is another pane's: both show
    const two = placeOverlays([
      { id: 'a', overlay: 'hint', since: 1, at: 'bl' },
      { id: 'b', overlay: 'hint', since: 2, at: 'br' },
    ]);
    expect([two.get('a'), two.get('b')]).toEqual(['bl', 'br']);
  });

  it('takes the corner given for one view of a split (the map style at the map pane)', () => {
    expect(placeOverlays([{ id: 'map', overlay: 'mapStyle', at: 'tl' }]).get('map')).toBe('tl');
  });

  it('places nothing on the stage for the island and the floating video', () => {
    const slots = placeOverlays([
      { id: 'island', overlay: 'island' },
      { id: 'video', overlay: 'video' },
    ]);
    expect([...slots.values()]).toEqual(['hidden', 'hidden']);
  });

  it('newest: the latest arrival, or none', () => {
    expect(newest([])).toBeNull();
    expect(
      newest([
        { id: 'a', since: 1 },
        { id: 'b', since: 4 },
        { id: 'c', since: 2 },
      ]),
    ).toBe('b');
  });
});
