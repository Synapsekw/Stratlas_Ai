import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILES = {
  'mission.css': join(import.meta.dirname, '../../../../packages/ui/src/mission.css'),
  'styles.css': join(import.meta.dirname, 'styles.css'),
};

// left/right that must stay physical: centring with translateX, and the Windows caption buttons.
const ALLOWED = [/^\s*left: 50%;/, /\/\* physical:/, /env\(titlebar-area/];

const PHYSICAL =
  /^\s*((margin|padding|border)-(left|right)(-\w+)?|border-(top|bottom)-(left|right)-radius|left|right)\s*:|text-align:\s*(left|right)/;

describe('right-to-left readiness', () => {
  for (const [name, path] of Object.entries(FILES)) {
    it(`${name} uses logical properties for left and right`, () => {
      const offenders = readFileSync(path, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => PHYSICAL.test(line) && !ALLOWED.some((a) => a.test(line)))
        .map(({ line, n }) => `${String(n)}: ${line.trim()}`);
      expect(offenders).toEqual([]);
    });
  }

  it('isolates numbers and codes inside mixed-direction text', () => {
    const css = readFileSync(FILES['styles.css'], 'utf8');
    expect(css).toMatch(/\.mono[^{]*\{[^}]*unicode-bidi: isolate/);
  });
});
