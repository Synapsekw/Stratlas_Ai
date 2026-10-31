import { createSplitPrefs } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import {
  migrateOldRightWidth,
  OLD_RIGHT_SPLIT_ID,
  panelBandOf,
  restingRightPx,
  rightSplit,
  rightSplitId,
  RIGHT_BANDS,
} from './panelWidth';

describe('the right panel width per band (D1)', () => {
  it('bands the window at 1440 and 1280 px', () => {
    expect(panelBandOf(1100)).toBe('narrow');
    expect(panelBandOf(1279)).toBe('narrow');
    expect(panelBandOf(1280)).toBe('mid');
    expect(panelBandOf(1439)).toBe('mid');
    expect(panelBandOf(1440)).toBe('wide');
  });

  it('opens at 360, 320 and 300 px, docked below 1280 px', () => {
    expect(restingRightPx('wide', undefined, false)).toBe(360);
    expect(restingRightPx('mid', undefined, false)).toBe(320);
    expect(restingRightPx('narrow', undefined, false)).toBe(300);
  });

  it('remembers a drag per band, kept inside the band', () => {
    expect(rightSplit('mid', false).id).not.toBe(rightSplit('wide', false).id);
    expect(restingRightPx('wide', 450, false)).toBe(450);
    expect(restingRightPx('narrow', 450, false)).toBe(RIGHT_BANDS.narrow.max);
    expect(restingRightPx('narrow', 13, false)).toBe(RIGHT_BANDS.narrow.min);
  });

  it('Expand panel opens at the band widest and leaves the remembered width alone', () => {
    expect(restingRightPx('wide', 360, true)).toBe(520);
    expect(rightSplit('wide', true)).toMatchObject({ min: 520, max: 520 });
    expect(restingRightPx('wide', 360, false)).toBe(360);
  });

  it('stays docked at 300 px below 1280 px: a drag never makes it narrower', () => {
    expect(RIGHT_BANDS.narrow.min).toBe(300);
    expect(restingRightPx('narrow', 250, false)).toBe(300);
  });

  it('carries a width dragged before the bands into the wide band, once', () => {
    const prefs = createSplitPrefs(null);
    prefs.getState().save(OLD_RIGHT_SPLIT_ID, { size: 430 });
    migrateOldRightWidth(prefs);
    expect(prefs.getState().byId[rightSplitId('wide')]?.size).toBe(430);
    // the narrower bands keep their fixed defaults
    expect(prefs.getState().byId[rightSplitId('narrow')]).toBeUndefined();
    // a width the wide band has of its own is never overwritten
    prefs.getState().save(rightSplitId('wide'), { size: 400 });
    migrateOldRightWidth(prefs);
    expect(prefs.getState().byId[rightSplitId('wide')]?.size).toBe(400);
  });

  it('holds a carried width to the wide band', () => {
    const prefs = createSplitPrefs(null);
    prefs.getState().save(OLD_RIGHT_SPLIT_ID, { size: 900 });
    migrateOldRightWidth(prefs);
    expect(prefs.getState().byId[rightSplitId('wide')]?.size).toBe(RIGHT_BANDS.wide.max);
  });
});
