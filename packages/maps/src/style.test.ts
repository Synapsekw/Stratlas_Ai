import { describe, expect, it } from 'vitest';
import { MAP_INK, oklchHex, STREET } from './ink';
import { BASEMAP_SOURCE, buildStyle, MISSION_DARK, STYLE_NAME } from './style';

/** Every string anywhere in a JSON value. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('Mission tokens as map colours', () => {
  it('converts the oklch tokens to the same hex the UI renders', () => {
    expect(oklchHex(0.145, 0.008, 250)).toBe('#080a0d');
    expect(oklchHex(0.945, 0.006, 250)).toBe('#eaedf1');
    expect(oklchHex(0.79, 0.115, 172)).toBe('#60d3b2');
    expect(oklchHex(0.66, 0.19, 25)).toBe('#f05653');
    expect(MAP_INK.sev[3]).toBe('#ebc751');
  });
});

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

  it('is always the dark Mission style: there is no light flavour to choose', () => {
    const style = buildStyle({ lang: 'en' });
    expect(style.name).toBe(STYLE_NAME);
    expect(STYLE_NAME).toBe('Mission dark');
    const bg = style.layers.find((l) => l.type === 'background');
    expect(bg?.paint).toMatchObject({ 'background-color': MISSION_DARK.background });
    // Options other than language and zoom are ignored, whatever a caller passes.
    const legacy = buildStyle({ lang: 'en', flavour: 'light' } as Parameters<typeof buildStyle>[0]);
    expect(legacy).toEqual(style);
    expect(luminance(MISSION_DARK.earth)).toBeLessThan(0.02);
  });

  it('keeps land, water and land use apart while staying quiet', () => {
    const earth = MISSION_DARK.earth;
    for (const c of [MISSION_DARK.water, MISSION_DARK.park_a, MISSION_DARK.sand]) {
      expect(c).not.toBe(earth);
      expect(contrast(c, earth)).toBeLessThan(1.6);
    }
    expect(MISSION_DARK.buildings).not.toBe(earth);
  });

  it('draws roads lighter by class, every class visible on the land', () => {
    const order = [MISSION_DARK.minor_a, MISSION_DARK.major, MISSION_DARK.highway];
    for (let i = 1; i < order.length; i++)
      expect(luminance(order[i] ?? '')).toBeGreaterThan(luminance(order[i - 1] ?? ''));
    expect(contrast(MISSION_DARK.minor_a, MISSION_DARK.earth)).toBeGreaterThan(1.3);
    expect(contrast(MISSION_DARK.highway, MISSION_DARK.earth)).toBeGreaterThan(2);
  });

  it('keeps labels legible on their halos', () => {
    const halo = MISSION_DARK.roads_label_major_halo;
    expect(contrast(MISSION_DARK.roads_label_major, halo)).toBeGreaterThan(6);
    expect(contrast(MISSION_DARK.roads_label_minor, halo)).toBeGreaterThan(4);
    expect(contrast(MISSION_DARK.city_label, MISSION_DARK.city_label_halo)).toBeGreaterThan(9);
  });

  it('leaves severity hues and the accent to the overlays', () => {
    const colours = strings(MISSION_DARK).filter((s) => /^#[0-9a-f]{6}$/i.test(s));
    expect(colours.length).toBeGreaterThan(60);
    for (const c of colours) {
      const ch = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      // Low chroma: no basemap colour can pass for a severity or the jade accent.
      expect(Math.max(...ch) - Math.min(...ch), c).toBeLessThan(60);
    }
  });

  it('keeps overlays readable on the land and the water', () => {
    const inks = [MAP_INK.acc, MAP_INK.fg2, MAP_INK.fg0, ...Object.values(MAP_INK.sev)];
    for (const ground of [STREET.earth, STREET.water])
      for (const ink of inks)
        expect(contrast(ink, ground), `${ink} on ${ground}`).toBeGreaterThan(4);
    // Crossing the brightest road (a highway) they still stand out.
    for (const ink of inks)
      expect(contrast(ink, STREET.highway), `${ink} on a highway`).toBeGreaterThan(2.2);
  });

  it('dims the pre-coloured POI icons under the overlays', () => {
    const pois = buildStyle({ lang: 'en' }).layers.find((l) => l.id === 'pois');
    expect(pois?.paint).toMatchObject({ 'icon-opacity': 0.5 });
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
