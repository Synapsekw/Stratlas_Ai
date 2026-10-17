import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import {
  OVERLAP_RAMP,
  RSRP_RAMP,
  SECTOR_RAMP,
  classShown,
  css,
  hex,
  type Oklch,
} from './coverageRamp';

/*
 * The legend is a dark overlay box (`data-surface="dark"`) on the map or the 3D view, in every
 * theme. These tests resolve its tokens from tokens.css the way the cascade does in each mode and
 * check the legend text (4.5:1) and the ramp swatches (3:1, non-text) against its surface: the
 * scrim, both as declared and over the brightest imagery under it (white).
 */
const css_ = readFileSync(
  join(import.meta.dirname, '../../../../../packages/ui/src/tokens.css'),
  'utf8',
);

function block(selectorStart: string): string {
  const start = css_.indexOf(selectorStart);
  if (start < 0) throw new Error(`No block ${selectorStart}`);
  return css_.slice(start, css_.indexOf('\n}', start));
}

function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    if (m[1] && m[2]) out[m[1]] = m[2].trim();
  return out;
}

const BASE = "[data-surface='dark'],\n:root {";
const MORE = ":root[data-contrast='more'],\n:root[data-contrast='more'] [data-surface='dark'] {";

/** The legend's tokens in a mode. */
function legendTokens(mode: 'dark' | 'light' | 'more'): Record<string, string> {
  const base = tokens(block(BASE));
  // light: the light theme block is on :root only; the dark surface declares its own values again
  if (mode === 'light') return base;
  if (mode === 'more') return { ...base, ...tokens(block(MORE)) };
  return base;
}

const OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/;

function parse(v: string): Oklch & { a: number } {
  const m = OKLCH.exec(v);
  if (!m) throw new Error(`Not oklch: ${v}`);
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]), a: m[4] ? Number(m[4]) : 1 };
}

/** sRGB (0 to 1, gamma encoded) of an oklch colour. */
function srgb(k: Oklch): [number, number, number] {
  const hx = hex(k);
  return [1, 3, 5].map((i) => parseInt(hx.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** oklch text of an sRGB colour (the inverse OKLab transform). */
function toOklch([r, g, b]: [number, number, number]): string {
  const lin = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, Bb);
  const H = ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360;
  return `oklch(${L.toFixed(4)} ${C.toFixed(4)} ${H.toFixed(2)})`;
}

/** The scrim as declared (opaque) and over white imagery (the browser blends in sRGB). */
function surfaces(t: Record<string, string>): string[] {
  const s = parse(t['--scrim'] ?? '');
  const c = srgb(s);
  const over = c.map((v) => s.a * v + (1 - s.a)) as [number, number, number];
  return [css(s), toOklch(over)];
}

const MODES = ['dark', 'light', 'more'] as const;
/** The tokens the legend's text uses (rf.css `.rf-legend*`). */
const TEXT = ['--fg-0', '--fg-1', '--fg-2'];

describe('the coverage legend colours', () => {
  it.each(MODES)('puts the legend text at 4.5:1 on its surface in %s mode', (mode) => {
    const t = legendTokens(mode);
    for (const bg of surfaces(t))
      for (const ink of TEXT) {
        const fg = t[ink];
        if (!fg) throw new Error(`No ${ink}`);
        expect(contrastRatio(fg, bg), `${mode} ${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
  });

  it.each(MODES)('sets every ramp swatch apart from the surface at 3:1 in %s mode', (mode) => {
    const t = legendTokens(mode);
    const swatches = [...Object.values(RSRP_RAMP), ...SECTOR_RAMP, ...Object.values(OVERLAP_RAMP)];
    for (const bg of surfaces(t))
      for (const k of swatches)
        expect(contrastRatio(css(k), bg), `${mode} ${css(k)} on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it('keeps the surface dark in the light theme (the overlay box declares its own tokens)', () => {
    expect(css_).toContain(BASE);
    // the legend asks for it
    const legend = readFileSync(join(import.meta.dirname, 'CoverageLegend.tsx'), 'utf8');
    expect(legend).toMatch(/className="rf-legend overlay-box"\s+data-surface="dark"/);
  });
});

describe('Show from', () => {
  it('hides the weaker classes and never draws no service', () => {
    expect(classShown('poor', 'all')).toBe(true);
    expect(classShown('poor', 'fair')).toBe(false);
    expect(classShown('fair', 'good')).toBe(false);
    expect(classShown('good', 'good')).toBe(true);
    expect(classShown('none', 'all')).toBe(false);
  });
});
