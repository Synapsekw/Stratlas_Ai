import { describe, expect, it } from 'vitest';
import { nextPicks, photoPicks } from './photoPicks';

const a = { layerId: 'ph', photoId: 'a' };
const b = { layerId: 'ph', photoId: 'b' };

describe('photo picks', () => {
  it('Ctrl toggles a photo, Shift adds without removing', () => {
    expect(nextPicks([a], b, { ctrl: true, shift: false })).toEqual([a, b]);
    expect(nextPicks([a, b], a, { ctrl: true, shift: false })).toEqual([b]);
    expect(nextPicks([a], a, { ctrl: false, shift: true })).toEqual([a]);
  });
  it('the store adds a box without doubles and clears', () => {
    photoPicks.getState().add([a, b]);
    photoPicks.getState().add([b]);
    expect(photoPicks.getState().picks).toEqual([a, b]);
    photoPicks.getState().clear();
    expect(photoPicks.getState().picks).toEqual([]);
  });
});
