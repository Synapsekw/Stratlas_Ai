import { describe, expect, it } from 'vitest';
import { placeCard } from './cardPlacement';

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
});
