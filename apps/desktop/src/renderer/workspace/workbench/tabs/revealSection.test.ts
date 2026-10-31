import { describe, expect, it } from 'vitest';
import { revealScrollTop } from './revealSection';

// a 600 px scroll box from y 100 to y 700
const box = { top: 100, bottom: 700 };

describe('revealScrollTop', () => {
  it('leaves a section that shows whole', () => {
    expect(revealScrollTop(box, { top: 400, bottom: 650 }, 120)).toBeNull();
  });

  it('leaves a tall section whose header is in the upper half', () => {
    expect(revealScrollTop(box, { top: 150, bottom: 2000 }, 0)).toBeNull();
  });

  it('brings a section below the box to its top', () => {
    expect(revealScrollTop(box, { top: 1800, bottom: 2400 }, 300)).toBe(2000);
  });

  it('brings a tall section starting low in the box to its top', () => {
    expect(revealScrollTop(box, { top: 550, bottom: 1500 }, 40)).toBe(490);
  });

  it('brings a section scrolled past above back down to its header', () => {
    expect(revealScrollTop(box, { top: -200, bottom: 300 }, 900)).toBe(600);
  });

  it('never scrolls above the start', () => {
    expect(revealScrollTop(box, { top: -50, bottom: 300 }, 20)).toBe(0);
  });
});
