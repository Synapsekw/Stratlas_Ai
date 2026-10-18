import { describe, expect, it } from 'vitest';
import {
  CHIP_TEXT_DARK,
  CHIP_TEXT_LIGHT,
  DET_SAFE_PALETTE,
  DET_WARN_PALETTE,
  chipLabel,
  chipTextColor,
  chipWidth,
  classColor,
  contrastRatio,
  detectionColor,
  isWarningClass,
  readableClass,
  boxInView,
  stackChips,
} from './classStyle';

describe('class colours', () => {
  it('gives a class the same colour every time, in any spelling', () => {
    expect(classColor('Safety_Jacket')).toBe(classColor('Safety_Jacket'));
    expect(classColor('Safety_Jacket')).toBe(classColor('safety jacket'));
    expect(classColor('safety-jacket')).toBe(classColor('SAFETY  JACKET'));
  });

  it('knows the classes that name an absence or a violation', () => {
    for (const n of ['No_Helmet', 'no-vest', 'NO gloves', 'Missing guard', 'without_harness'])
      expect(isWarningClass(n), n).toBe(true);
    for (const n of ['Helmet', 'Nozzle', 'Notebook', 'Safety_Jacket', 'person'])
      expect(isWarningClass(n), n).toBe(false);
  });

  it('draws warning classes warm and the others cool', () => {
    for (const n of ['No_Safety_Jacket', 'no-helmet', 'Missing barrier', 'Without gloves'])
      expect(DET_WARN_PALETTE).toContain(classColor(n));
    for (const n of ['Helmet', 'Safety_Jacket', 'Person', 'Gloves', 'Boots'])
      expect(DET_SAFE_PALETTE).toContain(classColor(n));
  });

  it('keeps the usual PPE classes apart', () => {
    const safe = ['Helmet', 'Safety_Jacket', 'Person', 'Gloves', 'Boots', 'Safety_Vest'];
    expect(new Set(safe.map(classColor)).size).toBe(safe.length);
    const warn = ['No_Helmet', 'No_Safety_Jacket', 'No_Gloves'];
    expect(new Set(warn.map(classColor)).size).toBe(warn.length);
  });

  it('prefers the project class colour when there is one', () => {
    expect(detectionColor('#123456', 'Helmet')).toBe('#123456');
    expect(detectionColor(undefined, 'Helmet')).toBe(classColor('Helmet'));
  });

  it('has palettes of distinct colours', () => {
    const all = [...DET_WARN_PALETTE, ...DET_SAFE_PALETTE];
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all.length).toBeLessThanOrEqual(10);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('chip text colour', () => {
  it('picks dark text on light fills and light text on dark fills', () => {
    expect(chipTextColor('#ffb825')).toBe(CHIP_TEXT_DARK);
    expect(chipTextColor('#3adaf2')).toBe(CHIP_TEXT_DARK);
    expect(chipTextColor('#cc2538')).toBe(CHIP_TEXT_LIGHT);
    expect(chipTextColor('#203040')).toBe(CHIP_TEXT_LIGHT);
    expect(chipTextColor('#fff')).toBe(CHIP_TEXT_DARK);
  });

  it('falls back to dark text for colours it cannot read', () => {
    expect(chipTextColor('oklch(0.6 0.1 20)')).toBe(CHIP_TEXT_DARK);
  });

  it('reads every palette colour at 3:1 or better with its chosen text', () => {
    for (const c of [...DET_WARN_PALETTE, ...DET_SAFE_PALETTE])
      expect(contrastRatio(c, chipTextColor(c)), c).toBeGreaterThanOrEqual(3);
  });
});

describe('chip labels', () => {
  it('turns class names into readable words', () => {
    expect(readableClass('No_Safety_Jacket')).toBe('No safety jacket');
    expect(readableClass('safety-jacket')).toBe('Safety jacket');
    expect(readableClass('Helmet')).toBe('Helmet');
    expect(readableClass('NO-PPE_vest')).toBe('NO PPE vest');
    expect(readableClass('  person ')).toBe('Person');
  });

  it('adds the confidence', () => {
    expect(chipLabel('No_Safety_Jacket', 0.876)).toBe('No safety jacket 88%');
    expect(chipLabel('Helmet')).toBe('Helmet');
  });

  it('estimates wider chips for longer text', () => {
    expect(chipWidth('No safety jacket 88%')).toBeGreaterThan(chipWidth('Helmet 79%'));
    expect(chipWidth('')).toBe(12);
  });
});

describe('boxes in view', () => {
  const view = { width: 400, height: 300 };
  it('knows a box that shows, even in part, from one outside the view', () => {
    expect(boxInView(10, 10, 50, 50, view)).toBe(true);
    expect(boxInView(-40, 10, 5, 50, view)).toBe(true);
    expect(boxInView(-90, 10, -10, 50, view)).toBe(false);
    expect(boxInView(410, 10, 450, 50, view)).toBe(false);
    expect(boxInView(10, 310, 50, 350, view)).toBe(false);
  });
});

describe('chip stacking', () => {
  const view = { width: 400, height: 300 };

  it('puts a chip just above its box, and inside it near the top of the view', () => {
    expect(stackChips([{ x: 50, y: 100, w: 80, h: 18 }], view)).toEqual([{ x: 50, y: 82 }]);
    expect(stackChips([{ x: 50, y: 6, w: 80, h: 18 }], view)).toEqual([{ x: 50, y: 6 }]);
    expect(stackChips([{ x: 50, y: -40, w: 80, h: 18 }], view)).toEqual([{ x: 50, y: 0 }]);
  });

  it('keeps chips inside the view sideways', () => {
    expect(stackChips([{ x: 360, y: 100, w: 80, h: 18 }], view)[0]?.x).toBe(320);
    expect(stackChips([{ x: -30, y: 100, w: 80, h: 18 }], view)[0]?.x).toBe(0);
  });

  it('moves a chip that would cover another one up above it', () => {
    const out = stackChips(
      [
        { x: 50, y: 100, w: 80, h: 18 },
        { x: 70, y: 104, w: 80, h: 18 },
      ],
      view,
    );
    expect(out[0]).toEqual({ x: 50, y: 82 });
    expect(out[1]).toEqual({ x: 70, y: 62 });
  });

  it('moves it down instead when up would leave the view', () => {
    const out = stackChips(
      [
        { x: 50, y: 10, w: 80, h: 18 },
        { x: 70, y: 12, w: 80, h: 18 },
      ],
      view,
    );
    expect(out[0]).toEqual({ x: 50, y: 10 });
    expect(out[1]).toEqual({ x: 70, y: 30 });
  });

  it('leaves chips that do not touch alone', () => {
    const out = stackChips(
      [
        { x: 10, y: 100, w: 80, h: 18 },
        { x: 200, y: 100, w: 80, h: 18 },
      ],
      view,
    );
    expect(out).toEqual([
      { x: 10, y: 82 },
      { x: 200, y: 82 },
    ]);
  });
});
