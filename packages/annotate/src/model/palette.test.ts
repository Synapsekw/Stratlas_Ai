import { describe, expect, it } from 'vitest';
import { CLASS_PALETTE, nextClassColour } from './palette';

describe('class palette', () => {
  it('has distinct #rrggbb colours', () => {
    expect(new Set(CLASS_PALETTE.map((c) => c.toLowerCase())).size).toBe(CLASS_PALETTE.length);
    for (const c of CLASS_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('returns the first colour no class uses yet (any case)', () => {
    expect(nextClassColour([])).toBe(CLASS_PALETTE[0]);
    expect(nextClassColour([String(CLASS_PALETTE[0]).toUpperCase()])).toBe(CLASS_PALETTE[1]);
  });

  it('cycles once every colour is used', () => {
    const all = [...CLASS_PALETTE];
    expect(nextClassColour(all)).toBe(CLASS_PALETTE[all.length % CLASS_PALETTE.length]);
    expect(nextClassColour([...all, '#000000'])).toBe(CLASS_PALETTE[1]);
  });
});
