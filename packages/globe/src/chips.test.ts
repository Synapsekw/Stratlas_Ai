import { describe, expect, it } from 'vitest';
import { CARD_GAP, CHIP, chipMetrics, fitLabel, issueBadge, placeCard } from './chips';

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
