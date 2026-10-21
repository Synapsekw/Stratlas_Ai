import type { ThermalFile, ThermalSettings } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_DEFAULTS,
  applySettings,
  changedSettings,
  effectiveSettings,
  settingsDiffer,
} from './settings';

const S = (o: Partial<ThermalSettings> = {}): ThermalSettings => ({
  emissivity: 0.9,
  distanceM: 3,
  airC: 10,
  humidityPct: 20,
  reflectedC: 5,
  ...o,
});
const file = (o: Partial<ThermalFile> = {}): ThermalFile => ({
  schema: 'aio.thermal/1',
  photos: {},
  readings: [],
  hotspots: [],
  ...o,
});

describe('effectiveSettings', () => {
  it('uses the photo first', () => {
    const f = file({ defaults: S({ airC: 1 }), photos: { 'L/p': { settings: S({ airC: 2 }) } } });
    expect(effectiveSettings(f, 'L', 'p', {}, 0)).toEqual(S({ airC: 2 }));
  });
  it('then the file defaults', () => {
    expect(effectiveSettings(file({ defaults: S() }), 'L', 'p', {}, 0)).toEqual(S());
  });
  it('then the design defaults, with distance from the height above take-off', () => {
    const e = effectiveSettings(file(), 'L', 'p', { pos: [0, 42, 0] }, 30);
    expect(e).toEqual({ ...DESIGN_DEFAULTS, distanceM: 12 });
    expect(DESIGN_DEFAULTS).toMatchObject({
      emissivity: 0.95,
      airC: 25,
      humidityPct: 50,
      reflectedC: null,
    });
  });
  it('prefers dji.relAlt, else 10 m', () => {
    const d = (item: Parameters<typeof effectiveSettings>[3], h: number | null) =>
      effectiveSettings(file(), 'L', 'p', item, h).distanceM;
    expect(d({ dji: { relAlt: 55 }, pos: [0, 99, 0] }, 0)).toBe(55);
    expect(d({}, 0)).toBe(10);
    expect(d({ pos: [0, 5, 0] }, null)).toBe(10);
    expect(d({ pos: [0, 5, 0] }, 9)).toBe(10);
  });
});

describe('applySettings', () => {
  it('writes the selected photos only, leaving the rest and the readings alone', () => {
    const f = file({
      photos: { 'L/a': { settings: S() }, 'L/b': { settings: S({ airC: 7 }) } },
      readings: [
        {
          id: 'r',
          layer: 'L',
          photo: 'a',
          geom: { type: 'point', p: [1, 1] } as never,
          stats: { maxC: 1, minC: 1, meanC: 1 },
        },
      ],
    });
    const g = applySettings(f, ['L/a', 'L/c'], { emissivity: 0.5 });
    expect(g.photos['L/a']?.settings).toEqual(S({ emissivity: 0.5 }));
    expect(g.photos['L/b']).toBe(f.photos['L/b']);
    expect(g.photos['L/c']?.settings).toEqual({ ...DESIGN_DEFAULTS, emissivity: 0.5 });
    expect(g.readings).toBe(f.readings);
    expect(f.photos['L/a']?.settings.emissivity).toBe(0.9);
  });
  it('starts a new photo from the file defaults when there are some', () => {
    const g = applySettings(file({ defaults: S() }), ['L/c'], { airC: 1 });
    expect(g.photos['L/c']?.settings).toEqual(S({ airC: 1 }));
  });
  it('starts a photo with no settings of its own from its own effective settings', () => {
    // b's raster was decoded at 42 m (its height): applying an emissivity keeps that distance
    const f = file({ photos: { 'L/a': { settings: S() } } });
    const g = applySettings(
      f,
      ['L/a', 'L/b'],
      { emissivity: 0.5 },
      {
        'L/b': { ...DESIGN_DEFAULTS, distanceM: 42 },
      },
    );
    expect(g.photos['L/a']?.settings).toEqual(S({ emissivity: 0.5 }));
    expect(g.photos['L/b']?.settings).toEqual({
      ...DESIGN_DEFAULTS,
      distanceM: 42,
      emissivity: 0.5,
    });
  });
});

describe('changedSettings', () => {
  it('keeps only the fields that differ from where the form started', () => {
    expect(changedSettings(S(), S())).toEqual({});
    expect(changedSettings(S(), S({ emissivity: 0.5, reflectedC: null }))).toEqual({
      emissivity: 0.5,
      reflectedC: null,
    });
  });
});

describe('settingsDiffer', () => {
  it('compares every field but the clamped ones', () => {
    expect(settingsDiffer(S(), S(), [])).toBe(false);
    expect(settingsDiffer(S(), S({ emissivity: 0.8 }), [])).toBe(true);
    expect(settingsDiffer(S({ reflectedC: null }), S(), [])).toBe(true);
    // the SDK held the distance to 25 m: asking for 80 m is what made that raster
    expect(settingsDiffer(S({ distanceM: 80 }), S({ distanceM: 25 }), ['distanceM'])).toBe(false);
    expect(settingsDiffer(S({ distanceM: 80, airC: 3 }), S({ distanceM: 25 }), ['distanceM'])).toBe(
      true,
    );
  });
});
