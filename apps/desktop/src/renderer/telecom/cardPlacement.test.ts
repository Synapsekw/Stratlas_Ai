import { describe, expect, it } from 'vitest';
import { AVOID_WEIGHT, CARD_MIN_H, leaderLine, placeCard, type Rect } from './cardPlacement';

const stage = { x: 0, y: 0, w: 1000, h: 800 };
const card = { w: 320, h: 420 };

describe('placeCard', () => {
  it('goes right of the box, vertically centred', () => {
    const p = placeCard({ x: 400, y: 200, w: 60, h: 300 }, stage, card, null);
    expect(p).toEqual({ x: 476, y: 140, docked: false });
  });
  it('goes left when the right side does not fit', () => {
    const p = placeCard({ x: 900, y: 200, w: 60, h: 300 }, stage, card, null);
    expect(p.docked).toBe(false);
    expect(p.x + 320).toBeLessThanOrEqual(884);
    expect(p.x).toBe(564);
  });
  it('docks top-right without a box', () => {
    expect(placeCard(null, stage, card, null)).toEqual({ x: 672, y: 8, docked: true });
  });
  it('docks when the box is off stage', () => {
    const p = placeCard({ x: 2000, y: 0, w: 10, h: 10 }, stage, card, null);
    expect(p).toEqual({ x: 672, y: 8, docked: true });
  });
  it('docks when the box fills the stage', () => {
    expect(placeCard({ ...stage }, stage, card, null).docked).toBe(true);
  });
  it('clamps a dragged position inside the stage', () => {
    const p = placeCard({ x: 400, y: 200, w: 60, h: 300 }, stage, card, { x: 2000, y: -50 });
    expect(p).toEqual({ x: 680, y: 0, docked: false });
  });
  it('goes above when neither side fits on a narrow stage', () => {
    const narrow = { x: 0, y: 0, w: 500, h: 1000 };
    const p = placeCard({ x: 100, y: 600, w: 300, h: 100 }, narrow, card, null);
    expect(p).toEqual({ x: 90, y: 164, docked: false });
  });
  it('goes below when neither side nor above fits', () => {
    const narrow = { x: 0, y: 0, w: 500, h: 1000 };
    const p = placeCard({ x: 100, y: 100, w: 300, h: 100 }, narrow, card, null);
    expect(p).toEqual({ x: 90, y: 216, docked: false });
  });
  it('takes the first corner that clears the box when no side, above or below fits', () => {
    // the box fills the top band: both top corners overlap it, the bottom-right clears
    const p = placeCard({ x: 0, y: 0, w: 1000, h: 370 }, stage, card, null);
    expect(p).toEqual({ x: 672, y: 372, docked: true });
  });
  it('takes the bottom-left corner when it covers least of the box', () => {
    // every corner overlaps; the bottom-left one by 28 x 418 px, the least
    const p = placeCard({ x: 300, y: 0, w: 700, h: 790 }, stage, card, null);
    expect(p).toEqual({ x: 8, y: 372, docked: true });
  });
  it('takes the corner that covers least of the box when nothing clears it', () => {
    // the left corners overlap the box by 308 px of width, the right ones by 320
    const p = placeCard({ x: 20, y: 0, w: 980, h: 800 }, stage, card, null);
    expect(p).toEqual({ x: 8, y: 8, docked: true });
  });
  it('lets a dragged position win on a narrow stage too', () => {
    const narrow = { x: 0, y: 0, w: 500, h: 1000 };
    const p = placeCard({ x: 100, y: 600, w: 300, h: 100 }, narrow, card, { x: 50, y: 60 });
    expect(p).toEqual({ x: 50, y: 60, docked: false });
  });
});

describe('placeCard with a reserved control', () => {
  // the Labels control in the bottom-left corner, 12 px in
  const control = { x: 12, y: 762, w: 170, h: 26 };
  it('lifts the bottom-left corner above the control', () => {
    // every corner overlaps the box; the bottom-left one, lifted to 762 - 8 - 420 = 334, least
    const p = placeCard({ x: 300, y: 0, w: 700, h: 700 }, stage, card, null, {
      reserved: [control],
    });
    expect(p).toEqual({ x: 8, y: 334, docked: true });
    // without the control it would stand at the stage's foot
    expect(placeCard({ x: 300, y: 0, w: 700, h: 700 }, stage, card, null).y).toBe(372);
  });
  it('lifts a side spot that would cover the control', () => {
    const p = placeCard({ x: 400, y: 700, w: 60, h: 100 }, stage, card, null, {
      reserved: [control],
    });
    // right of the box, clamped to the foot (380), clears the control: unchanged
    expect(p).toEqual({ x: 476, y: 380, docked: false });
    const q = placeCard({ x: 800, y: 700, w: 60, h: 100 }, { ...stage, w: 900 }, card, null, {
      reserved: [control],
    });
    // no room right; left of the box (x 464) is clear of the control's 12..182
    expect(q).toEqual({ x: 464, y: 380, docked: false });
  });
  it('drops a spot that cannot rise above the control', () => {
    const small = { x: 0, y: 0, w: 500, h: 500 };
    const tall = { w: 300, h: 470 };
    // left of the box (x 24) would clear the box but covers the control, with no room above it;
    // so do the left corners: a right corner, overlapping the box, is all that is left
    const p = placeCard({ x: 340, y: 0, w: 160, h: 500 }, small, tall, null, {
      reserved: [{ x: 12, y: 462, w: 170, h: 26 }],
    });
    expect(p).toEqual({ x: 192, y: 8, docked: true });
  });
  it('still lets a dragged position win', () => {
    const p = placeCard(null, stage, card, { x: 0, y: 500 }, { reserved: [control] });
    expect(p).toEqual({ x: 0, y: 380, docked: false });
  });
});

describe('placeCard with weighted areas', () => {
  const hit = (a: Rect, b: Rect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // a narrow stage where nothing clears the unit and its labels
  const narrow = { x: 0, y: 0, w: 500, h: 650 };
  const small = { w: 300, h: 300 };
  const unitBox = { x: 300, y: 250, w: 40, h: 80 };
  const name = { x: 280, y: 225, w: 90, h: 20 };
  const dims = [
    { x: 290, y: 335, w: 55, h: 20 },
    { x: 290, y: 360, w: 55, h: 20 },
  ];
  const angle = { x: 345, y: 280, w: 135, h: 20 };
  const avoid = { x: 280, y: 225, w: 200, h: 155 };
  const areas = [
    { rect: unitBox, weight: AVOID_WEIGHT.box },
    { rect: name, weight: AVOID_WEIGHT.name },
    { rect: angle, weight: AVOID_WEIGHT.angle },
    ...dims.map((rect) => ({ rect, weight: AVOID_WEIGHT.dim })),
  ];
  it('covers the dimension labels rather than the name or the box', () => {
    const p = placeCard(avoid, narrow, small, null, { areas });
    const at = { x: p.x, y: p.y, ...small };
    expect(p.docked).toBe(true);
    expect(hit(at, unitBox)).toBe(false);
    expect(hit(at, name)).toBe(false);
    expect(hit(at, angle)).toBe(false);
    expect(dims.some((d) => hit(at, d))).toBe(true);
  });
  it('without areas takes the corner that covers least of the avoid rect, as before', () => {
    const p = placeCard(avoid, narrow, small, null);
    expect([8, 192]).toContain(p.x);
  });
  it('still keeps clear of a reserved control', () => {
    const control = { x: 12, y: 612, w: 170, h: 26 };
    const p = placeCard(avoid, narrow, small, null, { areas, reserved: [control] });
    expect(hit({ x: p.x, y: p.y, ...small }, control)).toBe(false);
    expect(hit({ x: p.x, y: p.y, ...small }, unitBox)).toBe(false);
  });
});

describe('placeCard capped to a free band', () => {
  const hit = (a: Rect, b: Rect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // the CI window's stage (1100 x 720): the full card cannot clear the unit anywhere
  const ci = { x: 0, y: 0, w: 488, h: 720 };
  const tall = { w: 320, h: 334 };
  const unitBox = { x: 226, y: 317, w: 37, h: 86 };
  const name = { x: 198, y: 272, w: 91, h: 20 };
  const areas = [
    { rect: unitBox, weight: AVOID_WEIGHT.box },
    { rect: name, weight: AVOID_WEIGHT.name },
    { rect: { x: 303, y: 322, w: 149, h: 20 }, weight: AVOID_WEIGHT.angle },
    { rect: { x: 233, y: 368, w: 55, h: 20 }, weight: AVOID_WEIGHT.dim },
  ];
  const avoid = { x: 192, y: 266, w: 266, h: 143 };
  const control = { x: 12, y: 678, w: 173, h: 30 };

  it('caps the card to the larger band and keeps it off the box and the name', () => {
    const p = placeCard(avoid, ci, tall, null, { areas, reserved: [control] });
    // below the box: from 403 + 16 down to 8 px over the control (its columns reach it)
    expect(p.maxH).toBe(678 - 8 - 419);
    expect(p.y).toBe(419);
    expect(p.docked).toBe(false);
    const at = { x: p.x, y: p.y, w: tall.w, h: p.maxH ?? tall.h };
    expect(hit(at, unitBox)).toBe(false);
    expect(hit(at, name)).toBe(false);
    expect(hit(at, control)).toBe(false);
  });
  it('takes the band above when it is the larger', () => {
    const low = { ...ci, h: 500 };
    const p = placeCard(avoid, low, tall, null, { areas });
    // above: 8 .. 272 - 16 = 248 px; below: 419 .. 492 = 73 px
    expect(p.maxH).toBe(248);
    expect(p.y).toBe(8);
  });
  it('never caps below the floor', () => {
    const short = { ...ci, h: 560 };
    const p = placeCard({ ...avoid, y: 100 }, short, tall, null, {
      areas: [
        { rect: { ...unitBox, y: 150, h: 200 }, weight: AVOID_WEIGHT.box },
        { rect: { ...name, y: 120 }, weight: AVOID_WEIGHT.name },
      ],
    });
    expect(p.maxH).toBe(CARD_MIN_H);
  });
  it('does not cap when a full-height spot clears the box and the name', () => {
    const p = placeCard(avoid, { ...ci, w: 1000 }, tall, null, { areas });
    expect(p.maxH).toBeUndefined();
  });
  it('does not cap a dragged card', () => {
    const p = placeCard(avoid, ci, tall, { x: 10, y: 10 }, { areas });
    expect(p).toEqual({ x: 10, y: 10, docked: false });
  });
});

describe('leaderLine', () => {
  const box = { x: 100, y: 600, w: 300, h: 100 };
  it('runs from the box side to the card beside it', () => {
    expect(leaderLine(box, { x: 416, y: 440 }, card)).toEqual({
      x1: 400,
      y1: 650,
      x2: 416,
      y2: 650,
    });
    expect(leaderLine(box, { x: -236, y: 700 }, card)).toEqual({
      x1: 100,
      y1: 650,
      x2: 84,
      y2: 712,
    });
  });
  it('runs from the box top to the bottom edge of a card above it', () => {
    expect(leaderLine(box, { x: 90, y: 164 }, card)).toEqual({
      x1: 250,
      y1: 600,
      x2: 250,
      y2: 584,
    });
  });
  it('runs from the box bottom to the top edge of a card below it, kept off its corners', () => {
    expect(leaderLine(box, { x: 300, y: 716 }, card)).toEqual({
      x1: 250,
      y1: 700,
      x2: 312,
      y2: 716,
    });
  });
});
