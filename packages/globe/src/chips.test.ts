import { describe, expect, it } from 'vitest';
import {
  CARD_GAP,
  CHIP,
  CHIP_GAP,
  chipBox,
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

  it('cluster chip label starts after the dot', () => {
    // a gathered chip ("3 sites") has no badge: its words start clear of its dot
    const m = chipMetrics(42, null);
    expect(m.nameX).toBeGreaterThan(CHIP.dotX + CHIP.dotRadius);
    expect(m.badge).toBeNull();
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
    // `a` and `b` are stacked and end at 128; their chip runs from their dot to 168, where `c`,
    // clear of both by 44 px, starts at 172
    const a = chip('a', 100, 100, 40);
    const b = chip('b', 100, 120, 40);
    const c = chip('c', 172 + CHIP.dotX, 110, 60);
    expect(members([c, a])).toEqual([['a'], ['c']]);
    expect(members([c, b])).toEqual([['b'], ['c']]);
    expect(members([c, a, b])).toEqual([['a', 'b', 'c']]);
  });

  it('runs a gathered chip to the right of its dot, at the middle of its sites', () => {
    // `c` ends at 270, 18 px left of the pair's own chips: a chip centred on the pair (from 260)
    // would reach it; one that starts at the pair's dot (288) does not
    const a = chip('a', 300, 100, 40);
    const b = chip('b', 300, 120, 40);
    const c = chip('c', 230 + CHIP.dotX, 110, 40);
    const [pair] = groupChips([a, b], clusterSize);
    expect(pair).toEqual({ ids: ['a', 'b'], x: 300, y: 110 });
    expect(members([a, b, c])).toEqual([['a', 'b'], ['c']]);
    expect(chipBox(300, 110, 80, CHIP.height)).toEqual({
      left: 300 - CHIP.dotX,
      top: 110 - CHIP.height / 2,
      right: 300 - CHIP.dotX + 80,
      bottom: 110 + CHIP.height / 2,
    });
  });

  it('goes on for as long as a gathered chip reaches another', () => {
    // a gathered chip that widens by 100 px with every chip it takes in, and narrow chips 100 px
    // apart to the right of it: each round it reaches further along the row, until all are in
    const widening = (count: number) => ({ width: 100 + 100 * count, height: CHIP.height });
    const row = Array.from({ length: 10 }, (_, k) => 150 + 100 * k);
    const chips = [
      chip('a', 0, 100, 20),
      chip('b', 0, 110, 20),
      ...row.map((x, k) => chip(`right ${String(k)}`, x, 105, 20)),
    ];
    // on their own the narrow chips are apart
    expect(groupChips(chips.slice(2), widening)).toHaveLength(10);
    const all = groupChips(chips, widening);
    expect(all).toHaveLength(1);
    expect(all[0]?.ids).toHaveLength(12);
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
