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
});
