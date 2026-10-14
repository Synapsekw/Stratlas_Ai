import { defaultGlobeSettings, type GlobeSettings } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { globeBaseOf, globeDraw, globePacksOf, globeStyleFor, withBase } from './globeBase';

const ON = { enabled: true, source: 's2cloudless-2016' as const };
const OFF = { enabled: false, source: 'esri-world-imagery' as const };
const prefs = (over: Partial<GlobeSettings> = {}): GlobeSettings => ({
  ...defaultGlobeSettings(),
  ...over,
});

describe('the Globe base map from globe.json', () => {
  it('globeBaseOf keeps the Satellite look of 0.11', () => {
    expect(globeBaseOf(prefs({ style: 'satellite' }), ON)).toBe('s2cloudless-2016');
    expect(globeBaseOf(prefs({ style: 'satellite' }), OFF)).toBe('streets');
    expect(globeBaseOf(prefs({ style: 'natural-earth' }), ON)).toBe('natural-earth');
    expect(globeBaseOf(prefs(), ON)).toBe('streets');
    expect(globeBaseOf(prefs({ style: 'street', base: 'mapbox-dark' }), OFF)).toBe('mapbox-dark');
  });

  it('packs are on in the Satellite and Natural Earth looks unless switched', () => {
    expect(globePacksOf(prefs())).toBe(false);
    expect(globePacksOf(prefs({ style: 'satellite' }))).toBe(true);
    expect(globePacksOf(prefs({ style: 'natural-earth' }))).toBe(true);
    expect(globePacksOf(prefs({ style: 'satellite', packs: false }))).toBe(false);
  });

  it('writes a style 0.11 understands beside the base', () => {
    expect(globeStyleFor('streets', false)).toBe('street');
    expect(globeStyleFor('streets', true)).toBe('satellite');
    expect(globeStyleFor('natural-earth', false)).toBe('natural-earth');
    expect(globeStyleFor('esri-world-imagery', false)).toBe('satellite');
    expect(withBase(prefs({ terrain: 'off' }), 'esri-world-imagery', false)).toMatchObject({
      base: 'esri-world-imagery',
      packs: false,
      style: 'satellite',
      terrain: 'off',
    });
  });

  it('draws the look and the online source of what is drawn', () => {
    expect(globeDraw('esri-world-imagery', true)).toEqual({
      style: 'satellite',
      online: 'esri-world-imagery',
    });
    expect(globeDraw('streets', false)).toEqual({ style: 'street', online: null });
    expect(globeDraw('natural-earth', true)).toEqual({ style: 'natural-earth', online: null });
  });
});
