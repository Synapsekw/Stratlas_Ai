import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');

/** Custom properties declared in the first block whose selector matches exactly. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block`);
  const end = css.indexOf('\n}', start);
  const body = css.slice(start, end);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out.set(m[1] ?? '', m[2] ?? '');
  return out;
}

const NON_COLOUR = /^--(f-|t-|r-|ease|sb-|tb-)/;

describe('design tokens', () => {
  const dark = block(':root');
  const light = block(":root[data-theme='light']");

  it('gives the light theme a value for every colour token of the dark theme', () => {
    const colours = [...dark.keys()].filter((k) => !NON_COLOUR.test(k));
    expect(colours.length).toBeGreaterThan(40);
    const missing = colours.filter((k) => !light.has(k));
    expect(missing).toEqual([]);
  });

  it('keeps layout, type and motion tokens shared between themes', () => {
    for (const k of light.keys()) expect(NON_COLOUR.test(k)).toBe(false);
  });

  it('declares the colour scheme of each theme', () => {
    expect(css).toMatch(/:root \{\s*color-scheme: dark;/);
    expect(css).toMatch(/:root\[data-theme='light'\] \{\s*color-scheme: light;/);
  });

  it('has the semantic tokens the shell needs in both themes', () => {
    for (const k of ['--shadow', '--scrollbar', '--map-bg', '--danger-ink', '--warn-line']) {
      expect(dark.has(k), k).toBe(true);
      expect(light.has(k), k).toBe(true);
    }
  });

  it('gives warning text a still darker amber in the light theme with more contrast', () => {
    const more = block(":root[data-theme='light'][data-contrast='more']");
    expect(more.get('--warn-ink')).toBe('oklch(0.42 0.1 75)');
    const ink = oklch(more.get('--warn-ink') ?? '');
    for (const bg of ['--bg-0', '--bg-1', '--bg-2', '--bg-3'])
      expect(contrast(ink, oklch(light.get(bg) ?? '')), bg).toBeGreaterThanOrEqual(6.5);
  });

  it('gives warning text an amber that reads at 4.5:1 on every surface of both themes', () => {
    for (const theme of [dark, light]) {
      const ink = oklch(theme.get('--warn-ink') ?? '');
      for (const bg of ['--bg-0', '--bg-1', '--bg-2', '--bg-3'])
        expect(contrast(ink, oklch(theme.get(bg) ?? '')), bg).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/** A token's `oklch(L C h)` value, or `var(--x)` resolved in the dark block. */
function oklch(value: string): [number, number, number] {
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
  if (ref) return oklch(block(':root').get(ref[1] ?? '') ?? '');
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value.trim());
  if (!m) throw new Error(`not an opaque oklch colour: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** WCAG relative luminance of an OKLCH colour (through linear sRGB, clipped to the gamut). */
function luminance([l, c, h]: [number, number, number]): number {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  const r = clip(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S);
  const g = clip(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S);
  const bl = clip(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(x: [number, number, number], y: [number, number, number]): number {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
