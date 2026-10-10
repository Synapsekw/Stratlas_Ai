import { GlobeSettings, defaultGlobeSettings } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { EARTH_SHAPES_CREDIT, BUNDLED_CREDIT, planCredits } from './credits';
import { planGlobeLayers, planShowsPacks, styleZoomFor } from './layers';
import {
  GLOBE_LOOKS,
  IDLE_SPIN,
  WHOLE_EARTH_HEIGHT_M,
  globePixelRatio,
  idleSpinPending,
  idleSpinRate,
  wholeEarthAmount,
} from './look';
import {
  DEFAULT_GLOBE_STYLE,
  GLOBE_STYLES,
  STREET_GLOBE_PALETTE,
  globeStyleOf,
  hexRgb,
  withAlpha,
} from './style';

const pack = (id: string, maxZoom: number, half: number) => ({
  id,
  bbox: [50 - half, 25 - half, 50 + half, 25 + half] as [number, number, number, number],
  maxZoom,
  attribution: `${id} imagery`,
  customerLicence: false,
});
const WIDE = pack('wide', 8, 10);
const SITE = pack('site', 16, 0.1);
const kinds = (plan: readonly { kind: string }[]) => plan.map((l) => l.kind);

describe('the look in the settings', () => {
  it('is the street map unless the file names another', () => {
    expect(DEFAULT_GLOBE_STYLE).toBe('street');
    expect(globeStyleOf(defaultGlobeSettings())).toBe('street');
    expect(globeStyleOf(null)).toBe('street');
    for (const style of GLOBE_STYLES)
      expect(globeStyleOf(GlobeSettings.parse({ ...defaultGlobeSettings(), style }))).toBe(style);
  });

  it('reads colours for the scene and the pin canvases', () => {
    expect(hexRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(hexRgb('nonsense')).toEqual([0, 0, 0]);
    expect(withAlpha('#60d3b2', 0.5)).toBe('rgba(96, 211, 178, 0.5)');
    expect(withAlpha('#60d3b2', 4)).toBe('rgba(96, 211, 178, 1)');
    for (const colour of Object.values(STREET_GLOBE_PALETTE))
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('planGlobeLayers', () => {
  it('street map: the land shapes alone on a fresh install, never an imagery pack', () => {
    const plan = planGlobeLayers({ style: 'street', street: false, imagery: [WIDE, SITE] });
    expect(plan).toEqual([{ kind: 'earth-shapes', role: 'whole' }]);
    expect(planShowsPacks(plan)).toBe(false);
  });

  it('street map with street packs: the shapes under the street tiles', () => {
    const plan = planGlobeLayers({ style: 'street', street: true, imagery: [WIDE] });
    expect(plan).toEqual([{ kind: 'earth-shapes', role: 'underlay' }, { kind: 'street' }]);
  });

  it('satellite: the imagery packs over the street globe, the most detailed on top', () => {
    const plan = planGlobeLayers({ style: 'satellite', street: true, imagery: [SITE, WIDE] });
    expect(kinds(plan)).toEqual(['earth-shapes', 'street', 'imagery-pack', 'imagery-pack']);
    expect(plan.flatMap((l) => (l.kind === 'imagery-pack' ? [l.pack.id] : []))).toEqual([
      'wide',
      'site',
    ]);
    // without packs it is the street globe
    expect(planGlobeLayers({ style: 'satellite', street: false, imagery: [] })).toEqual([
      { kind: 'earth-shapes', role: 'whole' },
    ]);
  });

  it('natural earth: the old raster with the packs, and no street tiles', () => {
    const plan = planGlobeLayers({ style: 'natural-earth', street: true, imagery: [WIDE] });
    expect(kinds(plan)).toEqual(['natural-earth', 'imagery-pack']);
  });

  it('credits what each plan draws, each source once', () => {
    const osm = '© OpenStreetMap contributors';
    const street = planGlobeLayers({ style: 'street', street: true, imagery: [WIDE] });
    expect(planCredits(street, osm)).toEqual([EARTH_SHAPES_CREDIT, osm]);
    const satellite = planGlobeLayers({ style: 'satellite', street: true, imagery: [WIDE, SITE] });
    expect(
      planCredits(satellite, osm, [{ attribution: 'Terrain', customerLicence: true }]),
    ).toEqual([
      EARTH_SHAPES_CREDIT,
      osm,
      'wide imagery',
      'site imagery',
      'Terrain (customer licence)',
    ]);
    const old = planGlobeLayers({ style: 'natural-earth', street: false, imagery: [] });
    expect(planCredits(old, osm)).toEqual([BUNDLED_CREDIT]);
  });
});

describe('styleZoomFor', () => {
  it('draws every street tile in view in the style of the deepest one', () => {
    // the deepest tile in view is at level 6: its neighbours one and two levels up follow it
    expect(styleZoomFor(6, 6, 2)).toBe(6);
    expect(styleZoomFor(5, 6, 2)).toBe(6);
    expect(styleZoomFor(4, 6, 2)).toBe(6);
  });

  it('follows the view only as far as the source can draw, and never below the tile itself', () => {
    expect(styleZoomFor(2, 6, 2)).toBe(4);
    expect(styleZoomFor(8, 6, 2)).toBe(8);
    expect(styleZoomFor(5, 6, 0)).toBe(5);
    expect(styleZoomFor(5, 6, -1)).toBe(5);
  });

  it('is the tile own level before the view is known', () => {
    expect(styleZoomFor(5, null, 2)).toBe(5);
  });
});

describe('what a graphics preset buys the Globe', () => {
  it('Low draws one device pixel per CSS pixel, without the aura or the idle turn', () => {
    expect(GLOBE_LOOKS.low).toMatchObject({
      maxPixelRatio: 1,
      aura: false,
      idleSpin: false,
      msaa: 1,
    });
    expect(GLOBE_LOOKS.medium.aura && GLOBE_LOOKS.high.aura && GLOBE_LOOKS.ultra.aura).toBe(true);
  });

  it('draws at the screen density, up to what the preset allows', () => {
    expect(globePixelRatio(2, GLOBE_LOOKS.low)).toBe(1);
    expect(globePixelRatio(2, GLOBE_LOOKS.medium)).toBe(1.5);
    expect(globePixelRatio(1.25, GLOBE_LOOKS.medium)).toBe(1.25);
    expect(globePixelRatio(3, GLOBE_LOOKS.ultra)).toBe(2);
    expect(globePixelRatio(0.8, GLOBE_LOOKS.high)).toBe(1);
    expect(globePixelRatio(Number.NaN, GLOBE_LOOKS.high)).toBe(1);
  });

  it('street tiles are drawn at least as sharply as the Earth without them', () => {
    for (const look of Object.values(GLOBE_LOOKS))
      expect(look.streetScreenSpaceError).toBeLessThanOrEqual(look.screenSpaceError);
  });

  it('the whole-Earth light is full far out and gone near the ground', () => {
    expect(wholeEarthAmount(WHOLE_EARTH_HEIGHT_M)).toBe(1);
    expect(wholeEarthAmount(20_000_000)).toBe(1);
    expect(wholeEarthAmount(500_000)).toBe(0);
    expect(wholeEarthAmount(1_500)).toBe(0);
    const mid = wholeEarthAmount(3_000_000);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('the idle turn', () => {
  const { delayMs, easeMs, runMs, degPerSecond } = IDLE_SPIN;

  it('waits, eases in, turns, eases out and rests', () => {
    expect(idleSpinRate(0)).toBe(0);
    expect(idleSpinRate(delayMs)).toBe(0);
    const starting = idleSpinRate(delayMs + easeMs / 4);
    expect(starting).toBeGreaterThan(0);
    expect(starting).toBeLessThan(degPerSecond / 2);
    expect(idleSpinRate(delayMs + runMs / 2)).toBe(degPerSecond);
    const stopping = idleSpinRate(delayMs + runMs - easeMs / 4);
    expect(stopping).toBeCloseTo(starting, 10);
    expect(idleSpinRate(delayMs + runMs)).toBe(0);
    expect(idleSpinRate(delayMs + runMs * 10)).toBe(0);
  });

  it('asks for frames only until it has come to rest', () => {
    expect(idleSpinPending(0)).toBe(true);
    expect(idleSpinPending(delayMs + runMs - 1)).toBe(true);
    expect(idleSpinPending(delayMs + runMs)).toBe(false);
  });

  it('never turns faster than its pace, whatever the spin', () => {
    const quick = { delayMs: 0, easeMs: 5000, runMs: 2000, degPerSecond: 3 };
    for (let t = 0; t <= 2000; t += 100) expect(idleSpinRate(t, quick)).toBeLessThanOrEqual(3);
    expect(idleSpinRate(1000, quick)).toBe(3);
  });
});
