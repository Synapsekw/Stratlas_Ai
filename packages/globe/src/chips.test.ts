import { describe, expect, it } from 'vitest';
import {
  CARD_GAP,
  CHIP,
  CHIP_GAP,
  chipMetrics,
  fitLabel,
  groupChips,
  issueBadge,
  placeCard,
  type PlacedChip,
} from './chips';

/** Ten pixels a character (a code point), whatever it is. */
const measure = (text: string) => Array.from(text).length * 10;

describe('fitLabel', () => {
  it('keeps a name that fits', () => {
    expect(fitLabel('Hill quarry', 110, measure)).toBe('Hill quarry');
  });

  it('cuts to the longest start that fits with its ellipsis', () => {
    // 80 px: seven characters and the ellipsis
    expect(fitLabel('Northern ridge', 80, measure)).toBe('Norther…');
  });

  it('drops a space left before the ellipsis', () => {
    // nine characters would end in the space of "Northern "
    expect(fitLabel('Northern ridge', 100, measure)).toBe('Northern…');
  });

  it('never splits a pair of surrogates', () => {
    const cut = fitLabel('𝔸𝔹ℂ𝔻𝔼𝔽', 40, measure);
    expect(cut).toBe('𝔸𝔹ℂ…');
    expect(Array.from(cut)).toHaveLength(4);
  });

  it('is only the ellipsis when nothing fits', () => {
    expect(fitLabel('Depot', 5, measure)).toBe('…');
  });
});

describe('issueBadge', () => {
  it('has no badge without open issues, and stops counting at 99', () => {
    expect(issueBadge(0)).toBeNull();
    expect(issueBadge(-1)).toBeNull();
    expect(issueBadge(1)).toBe('1');
    expect(issueBadge(99)).toBe('99');
    expect(issueBadge(100)).toBe('99+');
  });
});

describe('chipMetrics', () => {
  it('is the dot, the name and the room after it', () => {
    const m = chipMetrics(70.4, null);
    expect(m.height).toBe(CHIP.height);
    expect(m.nameX).toBe(CHIP.dotX + CHIP.nameGap);
    expect(m.badge).toBeNull();
    expect(m.width).toBe(Math.ceil(m.nameX + 70.4 + CHIP.endPad));
  });

  it('puts the badge after the name, at least as wide as it is high', () => {
    const one = chipMetrics(70, 6);
    expect(one.badge).toEqual({ x: one.nameX + 70 + CHIP.badgeGap, width: CHIP.badgeHeight });
    expect(one.width).toBe(one.nameX + 70 + CHIP.badgeGap + CHIP.badgeHeight + CHIP.badgeEnd);
    const many = chipMetrics(70, 19);
    expect(many.badge?.width).toBe(19 + 2 * CHIP.badgePadX);
    expect(Number.isInteger(many.width)).toBe(true);
  });
});

describe('groupChips', () => {
  const clusterSize = () => ({ width: 80, height: CHIP.height });
  const chip = (id: string, x: number, y: number, width = 100): PlacedChip => ({
    id,
    x,
    y,
    width,
    height: CHIP.height,
  });
  const members = (chips: PlacedChip[], gap?: number) =>
    groupChips(chips, clusterSize, gap).map((g) => g.ids);

  it('has nothing to gather without chips', () => {
    expect(groupChips([], clusterSize)).toEqual([]);
  });

  it('leaves chips that are far apart alone, each at its own dot', () => {
    expect(groupChips([chip('b', 400, 300), chip('a', 100, 100)], clusterSize)).toEqual([
      { ids: ['a'], x: 100, y: 100 },
      { ids: ['b'], x: 400, y: 300 },
    ]);
  });

  it('gathers two chips that overlap, whichever comes first', () => {
    // the name of `a` runs into `b`, whose dot is 60 px to its right
    const a = chip('a', 100, 100);
    const b = chip('b', 160, 100);
    const one = [{ ids: ['a', 'b'], x: 130, y: 100 }];
    expect(groupChips([a, b], clusterSize)).toEqual(one);
    expect(groupChips([b, a], clusterSize)).toEqual(one);
  });

  it('gathers a chip with the one above it', () => {
    expect(members([chip('a', 100, 100), chip('b', 100, 100 + CHIP.height - 1)])).toEqual([
      ['a', 'b'],
    ]);
    expect(members([chip('a', 100, 100), chip('b', 100, 100 + CHIP.height + CHIP_GAP)])).toEqual([
      ['a'],
      ['b'],
    ]);
  });

  it('counts chips nearer than the gap as overlapping', () => {
    // `a` ends at 188, `b` starts at 192
    const pair = [chip('a', 100, 100), chip('b', 192 + CHIP.dotX, 100)];
    expect(members(pair)).toEqual([['a', 'b']]);
    expect(members(pair, 0)).toEqual([['a'], ['b']]);
  });

  it('gathers a chain into one, though its ends are apart', () => {
    const a = chip('a', 100, 100);
    const b = chip('b', 180, 100);
    const c = chip('c', 260, 100);
    expect(members([a, c])).toEqual([['a'], ['c']]);
    expect(members([a, b, c])).toEqual([['a', 'b', 'c']]);
    expect(members([c, a, b])).toEqual([['a', 'b', 'c']]);
  });

  it('takes in a chip that the gathered chip would cover', () => {
    // `a` and `b` are stacked; their chip is centred on them and reaches left to 60, where `c`,
    // clear of both by 30 px, ends at 58
    const a = chip('a', 100, 100, 60);
    const b = chip('b', 100, 120, 60);
    const c = chip('c', 10, 110, 60);
    expect(members([c, a])).toEqual([['a'], ['c']]);
    expect(members([c, b])).toEqual([['b'], ['c']]);
    expect(members([c, a, b])).toEqual([['a', 'b', 'c']]);
  });

  it('goes on for as long as a gathered chip reaches another', () => {
    // a gathered chip that widens by 200 px with every pair it takes in, and narrow chips 100 px
    // apart on both sides of it: each round it reaches the next one on either side, and no more
    const widening = (count: number) => ({ width: 100 + 100 * count, height: CHIP.height });
    const pairs = Array.from({ length: 10 }, (_, k) => 150 + 100 * k);
    const chips = [
      chip('a', 0, 100, 20),
      chip('b', 0, 110, 20),
      ...pairs.map((x, k) => chip(`left ${String(k)}`, -x, 105, 20)),
      ...pairs.map((x, k) => chip(`right ${String(k)}`, x, 105, 20)),
    ];
    // on their own the narrow chips are apart
    expect(groupChips(chips.slice(2), widening)).toHaveLength(20);
    const all = groupChips(chips, widening);
    expect(all).toHaveLength(1);
    expect(all[0]?.ids).toHaveLength(22);
  });

  it('gathers the same chips when the view faces the other way', () => {
    const north = [chip('a', 100, 100, 120), chip('b', 160, 100, 80), chip('c', 600, 100)];
    // facing south, what was on the left is on the right; names still run to the right
    const south = north.map((c) => ({ ...c, x: 700 - c.x }));
    expect(members(north)).toEqual([['a', 'b'], ['c']]);
    expect(members(south)).toEqual([['a', 'b'], ['c']]);
    expect(members([...south].reverse())).toEqual([['a', 'b'], ['c']]);
  });

  it('answers the same for the same view', () => {
    const chips = [chip('a', 100, 100), chip('b', 150, 110), chip('c', 420, 100)];
    expect(groupChips(chips, clusterSize)).toEqual(groupChips(chips, clusterSize));
  });
});

describe('placeCard', () => {
  const view = { width: 848, height: 660 };
  const card = { width: 304, height: 120 };
  const insets = { top: 56, right: 12, bottom: 44, left: 12 };

  it('sits under the pin, its left edge at the chip’s', () => {
    expect(placeCard({ x: 400, y: 300 }, card, view, insets)).toEqual({
      left: 400 - CHIP.dotX,
      top: 300 + CARD_GAP,
      side: 'below',
    });
  });

  it('slides along the left and right edges', () => {
    expect(placeCard({ x: 4, y: 300 }, card, view, insets).left).toBe(12);
    expect(placeCard({ x: 840, y: 300 }, card, view, insets).left).toBe(848 - 12 - 304);
  });

  it('goes above the pin when there is no room below', () => {
    expect(placeCard({ x: 400, y: 560 }, card, view, insets)).toEqual({
      left: 400 - CHIP.dotX,
      top: 560 - CARD_GAP - 120,
      side: 'above',
    });
  });

  it('stays inside the insets when it fits neither way', () => {
    const tall = { width: 304, height: 500 };
    // more room below a pin near the top, above one near the bottom
    expect(placeCard({ x: 400, y: 200 }, tall, view, insets)).toMatchObject({
      top: 660 - 44 - 500,
      side: 'below',
    });
    expect(placeCard({ x: 400, y: 500 }, tall, view, insets)).toMatchObject({
      top: 56,
      side: 'above',
    });
  });

  it('keeps a card wider than the view at the left inset', () => {
    const wide = { width: 900, height: 120 };
    expect(placeCard({ x: 400, y: 300 }, wide, view, insets).left).toBe(12);
  });

  it('follows a pin that left the view to the nearest edge', () => {
    const off = placeCard({ x: -200, y: -100 }, card, view, insets);
    expect(off).toEqual({ left: 12, top: 56, side: 'below' });
  });

  it('answers in whole pixels', () => {
    const p = placeCard({ x: 400.6, y: 300.4 }, card, view, insets);
    expect(Number.isInteger(p.left) && Number.isInteger(p.top)).toBe(true);
  });
});
