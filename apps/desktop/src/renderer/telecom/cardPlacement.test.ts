import { describe, expect, it } from 'vitest';
import { leaderLine, placeCard } from './cardPlacement';

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
