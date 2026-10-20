// The report prints the app's charts and cards with the foundation tokens at their light-theme
// values (house.css `.pg`). This pins the two together: a token changed in tokens.css must change
// in the print block too, or be listed here as printed differently on purpose.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOUSE = readFileSync(join(__dirname, 'house.css'), 'utf8');
const TOKENS = readFileSync(
  join(__dirname, '../../../../../../packages/ui/src/tokens.css'),
  'utf8',
);

/** The custom properties of the first block whose selector is exactly `selector` (after `from`). */
function block(css: string, selector: string, from = 0): Map<string, string> {
  const at = css.indexOf(`${selector} {`, from);
  if (at < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
    out.set(m[1] ?? '', (m[2] ?? '').replace(/\s+/g, ' ').trim());
  return out;
}

/** Printed differently on purpose: white paper, the report's accent, no motion. */
const ON_PURPOSE: Readonly<Record<string, string>> = {
  '--bg-1': 'oklch(1 0 0)',
  '--chart-current': 'var(--acc)',
  '--d-1': '0ms',
  '--ease': 'linear',
};

describe('the report prints the chart and card tokens at their light-theme values', () => {
  it('every .pg token is the light theme value (else the base value)', () => {
    // the print block follows its comment ("The app's charts and measurement cards ...")
    const print = block(HOUSE, '.pg', HOUSE.indexOf("The app's charts and measurement cards"));
    const base = block(TOKENS, ':root');
    const light = block(TOKENS, ":root[data-theme='light']");
    expect(print.size).toBeGreaterThan(20);
    for (const [name, value] of print) {
      const want = ON_PURPOSE[name] ?? light.get(name) ?? base.get(name);
      expect(want, `${name} is not a token of tokens.css`).toBeDefined();
      expect(value, name).toBe(want);
    }
  });
});
