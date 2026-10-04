import { describe, expect, it } from 'vitest';
import { ASPRS_CLASSES, classColour, className, legendEntries } from './classes';

describe('ASPRS classes', () => {
  it('names the standard LAS 1.4 classes', () => {
    expect(className(2)).toBe('Ground');
    expect(className(6)).toBe('Building');
    expect(className(9)).toBe('Water');
    expect(className(77)).toBe('Class 77');
  });

  it('gives each of the 32 shader slots a CSS colour', () => {
    expect(ASPRS_CLASSES.length).toBeGreaterThanOrEqual(19);
    for (let c = 0; c < 32; c++) expect(classColour(c)).toMatch(/^#[0-9a-f]{6}$/);
    expect(classColour(2)).not.toBe(classColour(6));
  });

  it('lists the classes present, most points first, with shares', () => {
    expect(legendEntries({ 2: 600, 6: 300, 5: 100 })).toEqual([
      { code: 2, name: 'Ground', colour: classColour(2), points: 600, share: 0.6 },
      { code: 6, name: 'Building', colour: classColour(6), points: 300, share: 0.3 },
      { code: 5, name: 'High vegetation', colour: classColour(5), points: 100, share: 0.1 },
    ]);
    expect(legendEntries({})).toEqual([]);
  });
});
