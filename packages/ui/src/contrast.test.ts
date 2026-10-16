import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';

const css = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');

/** A token's value in the light theme block. */
function light(token: string): string {
  const start = css.indexOf(":root[data-theme='light'] {");
  const body = css.slice(start, css.indexOf('\n}', start));
  const m = new RegExp(`${token}: *([^;]+);`).exec(body);
  if (!m?.[1]) throw new Error(`No light ${token}`);
  return m[1];
}

describe('contrastRatio', () => {
  it('is 21 for white on black', () => {
    expect(contrastRatio('oklch(1 0 0)', 'oklch(0 0 0)')).toBeCloseTo(21, 1);
  });

  it('is symmetric and 1 for equal colours', () => {
    expect(contrastRatio('oklch(0.5 0.1 200)', 'oklch(0.5 0.1 200)')).toBeCloseTo(1, 5);
    expect(contrastRatio('oklch(0.9 0 0)', 'oklch(0.2 0 0)')).toBeCloseTo(
      contrastRatio('oklch(0.2 0 0)', 'oklch(0.9 0 0)'),
      10,
    );
  });

  it('puts the light amber text ink at AA on the panel surface', () => {
    expect(contrastRatio(light('--warn-ink'), light('--bg-1'))).toBeGreaterThanOrEqual(4.5);
  });

  it('shows why amber text needs its own ink: the swatch fails on the light panel', () => {
    expect(contrastRatio(light('--s3'), light('--bg-1'))).toBeLessThan(3);
  });

  it('rejects colours that are not oklch', () => {
    expect(() => contrastRatio('#fff', 'oklch(0 0 0)')).toThrow(/oklch/);
  });
});
