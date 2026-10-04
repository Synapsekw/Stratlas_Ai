import { describe, expect, it } from 'vitest';
import { BASEMAP_SOURCE, buildStyle, MISSION_DARK, MISSION_LIGHT } from './style';

/** Every string anywhere in a JSON value. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

describe('offline basemap style', () => {
  for (const lang of ['en', 'ar'] as const) {
    it(`has no URL outside aio:// or the bundled aiomap:// assets (${lang})`, () => {
      const style = buildStyle({ lang });
      const all = strings(style);
      const urlish = all.filter((s) => /:\/\/|^\/\/|^www\./i.test(s));
      expect(urlish.length).toBeGreaterThan(0);
      for (const s of urlish) expect(s).toMatch(/^(aiomap|aio):\/\//);
      for (const s of all) expect(s).not.toMatch(/https?:|mapbox|protomaps\.(com|dev|github)/i);
    });
  }

  it('serves tiles, glyphs and sprites from bundled protocol URLs', () => {
    const style = buildStyle({ lang: 'en' });
    const src = style.sources[BASEMAP_SOURCE];
    expect(src).toMatchObject({ type: 'vector', tiles: ['aiomap://tiles/{z}/{x}/{y}'] });
    expect(style.glyphs).toBe('aiomap://glyphs/{fontstack}/{range}.pbf');
    expect(style.sprite).toBe('aiomap://sprites/dark');
  });

  it('credits OpenStreetMap', () => {
    const src = buildStyle({ lang: 'en' }).sources[BASEMAP_SOURCE] as { attribution?: string };
    expect(src.attribution).toContain('OpenStreetMap');
  });

  it('uses the Mission palette', () => {
    const style = buildStyle({ lang: 'en' });
    const bg = style.layers.find((l) => l.type === 'background');
    expect(bg?.paint).toMatchObject({ 'background-color': MISSION_DARK.background });
  });

  it('has a light flavour for the light theme', () => {
    const style = buildStyle({ lang: 'en', flavour: 'light' });
    const bg = style.layers.find((l) => l.type === 'background');
    expect(bg?.paint).toMatchObject({ 'background-color': MISSION_LIGHT.background });
    expect(MISSION_LIGHT.background).not.toBe(MISSION_DARK.background);
    expect(style.sprite).toBe('aiomap://sprites/light');
    expect(style.name).toBe('Mission light');
    expect(buildStyle({ lang: 'en' }).name).toBe('Mission dark');
  });

  it('keeps the light flavour offline and on bundled fonts', () => {
    const all = strings(buildStyle({ lang: 'ar', flavour: 'light' }));
    for (const s of all) expect(s).not.toMatch(/https?:/i);
  });

  it('labels in English with the Arabic local name, or in Arabic', () => {
    const en = JSON.stringify(buildStyle({ lang: 'en' }).layers);
    expect(en).toContain('name:en');
    const ar = JSON.stringify(buildStyle({ lang: 'ar' }).layers);
    expect(ar).toContain('name:ar');
  });

  it('only uses font stacks that are bundled', () => {
    const fonts = new Set<string>();
    for (const s of strings(buildStyle({ lang: 'en' }).layers))
      if (s.startsWith('Noto Sans')) fonts.add(s);
    for (const f of fonts)
      expect(['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic']).toContain(f);
  });
});
