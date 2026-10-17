import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI = join(import.meta.dirname, '../../../../packages/ui/src');
const PARTS = ['button', 'tip', 'surface', 'tabs', 'chip', 'row', 'empty', 'split'];

const FILES = {
  'mission.css': join(UI, 'mission.css'),
  ...Object.fromEntries(PARTS.map((n) => [`parts/${n}.css`, join(UI, 'parts', `${n}.css`)])),
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

  it('keeps the window caption insets on the physical side, whatever the direction', () => {
    // the OS draws the Windows caption buttons on the right and the macOS traffic lights on the
    // left in every direction, so the room kept for them is physical (shell/caption.ts)
    const lines = readFileSync(FILES['styles.css'], 'utf8')
      .split('\n')
      .filter((line) => /var\(--caption-(end|start)/.test(line));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      if (line.includes('--caption-end')) expect(line).toMatch(/^\s*padding-right:/);
      else expect(line).toMatch(/^\s*padding-left:/);
      expect(line).toMatch(/\/\* physical: OS caption buttons \*\//);
    }
  });

  it('isolates numbers and codes inside mixed-direction text', () => {
    const css = readFileSync(FILES['styles.css'], 'utf8');
    expect(css).toMatch(/\.mono[^{]*\{[^}]*unicode-bidi: isolate/);
  });
});
