import { describe, expect, it } from 'vitest';
import { bandDefaults, bandOf, layersState, restingPx, type Band } from './layoutBands';

const SCENE = {
  setting: false,
  windowWidth: 1100,
  screen: 'scene',
  autoFold: true,
  reopened: false,
  overlayOpen: false,
};

describe('the window bands (UI revision D1)', () => {
  it('bands the window at 1440 and 1280 px', () => {
    expect(bandOf(1100)).toBe('narrow');
    expect(bandOf(1279)).toBe('narrow');
    expect(bandOf(1280)).toBe('mid');
    expect(bandOf(1439)).toBe('mid');
    expect(bandOf(1440)).toBe('wide');
    expect(bandOf(2560)).toBe('wide');
  });

  it('>= 1440 px: Layers open, panel 360 (320 to 520), strip 160', () => {
    expect(bandDefaults('wide')).toEqual({
      layersOpen: true,
      layersOverlay: false,
      rightPx: 360,
      rightMin: 320,
      rightMax: 520,
      stripPx: 160,
    });
  });

  it('1280 to 1440 px: Layers folded by default, panel 320 (300 to 480), strip 140', () => {
    expect(bandDefaults('mid')).toEqual({
      layersOpen: false,
      layersOverlay: false,
      rightPx: 320,
      rightMin: 300,
      rightMax: 480,
      stripPx: 140,
    });
  });

  it('1100 to 1280 px: Layers an overlay, panel docked at 300 (to 400), strip 120', () => {
    expect(bandDefaults('narrow')).toEqual({
      layersOpen: false,
      layersOverlay: true,
      rightPx: 300,
      // docked at 300 px and pushing the stage (founder, 30 Oct): no narrower by a drag
      rightMin: 300,
      rightMax: 400,
      stripPx: 120,
    });
  });

  it('leaves the stage at least 68 % at the smallest width of each band, Layers closed', () => {
    const rail = 52;
    for (const [band, width] of [
      ['wide', 1440],
      ['mid', 1280],
      ['narrow', 1100],
    ] as [Band, number][]) {
      const stage = width - rail - bandDefaults(band).rightPx;
      expect(stage / width).toBeGreaterThanOrEqual(0.68);
    }
  });
});

describe('a hand-set width per band', () => {
  it('survives a band change back and forth', () => {
    const saved: Partial<Record<Band, number>> = {};
    // dragged to 350 in the narrow band
    saved.narrow = 350;
    expect(restingPx('narrow', saved.narrow)).toBe(350);
    // the window grows: the wide band has its own default
    expect(restingPx('wide', saved.wide)).toBe(360);
    // dragged to 450 there
    saved.wide = 450;
    // back to narrow, then wide again: each band keeps its own drag
    expect(restingPx('narrow', saved.narrow)).toBe(350);
    expect(restingPx('wide', saved.wide)).toBe(450);
  });

  it('keeps a remembered width inside its band, and Expand opens at the widest', () => {
    expect(restingPx('narrow', 450)).toBe(400);
    expect(restingPx('narrow', 13)).toBe(300);
    expect(restingPx('wide', 360, true)).toBe(520);
  });
});

describe('the Layers column per band', () => {
  it('wide: open and docked', () => {
    expect(layersState({ ...SCENE, windowWidth: 1440 })).toEqual({
      shown: true,
      overlay: false,
    });
  });

  it("wide: a road project's preset folds it (D7)", () => {
    expect(layersState({ ...SCENE, windowWidth: 1440, foldWide: true })).toEqual({
      shown: false,
      overlay: false,
    });
    // the narrow band's overlay is the person's alone
    expect(layersState({ ...SCENE, windowWidth: 1100, foldWide: true, overlayOpen: true })).toEqual(
      { shown: true, overlay: true },
    );
  });

  it('mid: folded until the person opens it, then docked open', () => {
    expect(layersState({ ...SCENE, windowWidth: 1300 })).toEqual({
      shown: false,
      overlay: false,
    });
    expect(layersState({ ...SCENE, windowWidth: 1300, reopened: true })).toEqual({
      shown: true,
      overlay: false,
    });
  });

  it('narrow: an overlay over the stage, closed until opened', () => {
    expect(layersState(SCENE)).toEqual({ shown: false, overlay: true });
    expect(layersState({ ...SCENE, overlayOpen: true })).toEqual({ shown: true, overlay: true });
    // a reopen in the docked band does not open the overlay
    expect(layersState({ ...SCENE, reopened: true })).toEqual({ shown: false, overlay: true });
  });

  it('applies on the data screens only', () => {
    for (const screen of ['issues', 'inspect', 'reports'])
      expect(layersState({ ...SCENE, screen }).overlay).toBe(true);
    for (const screen of ['settings', 'projects', 'welcome', 'globe'])
      expect(layersState({ ...SCENE, screen })).toEqual({ shown: true, overlay: false });
  });

  it('never folds on its own when the flag is off (e2e pins it open)', () => {
    for (const windowWidth of [1100, 1300, 1600])
      expect(layersState({ ...SCENE, windowWidth, autoFold: false })).toEqual({
        shown: true,
        overlay: false,
      });
  });

  it("keeps the person's own choice to fold it at any width", () => {
    for (const windowWidth of [1100, 1300, 1920])
      for (const screen of ['scene', 'settings'])
        expect(layersState({ ...SCENE, setting: true, windowWidth, screen }).shown).toBe(false);
    expect(
      layersState({ ...SCENE, setting: true, reopened: true, autoFold: false, windowWidth: 1300 })
        .shown,
    ).toBe(false);
  });
});
