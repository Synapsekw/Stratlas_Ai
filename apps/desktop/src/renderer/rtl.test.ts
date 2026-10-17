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

  it('gives the room of the window buttons to the component at their edge, in either direction', () => {
    // the OS draws the Windows caption buttons on the right and the macOS traffic lights on the
    // left in every direction (shell/caption.ts): .app hands that physical room to the main
    // area's end and the sidebar's start, swapped right to left, and components take it on their
    // logical sides only
    const css = readFileSync(FILES['styles.css'], 'utf8');
    const block = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
    };
    expect(block('.app')).toContain('--caption-inline-end: var(--caption-right, 0px);');
    expect(block('.app')).toContain('--caption-inline-start: var(--caption-left, 0px);');
    expect(block("[dir='rtl'] .app")).toContain('--caption-inline-end: var(--caption-left, 0px);');
    expect(block("[dir='rtl'] .app")).toContain(
      '--caption-inline-start: var(--caption-right, 0px);',
    );
    const lines = css.split('\n');
    const physical = lines.filter(
      (l) => /var\(--caption-(left|right)/.test(l) && !/^\s*--caption-inline-(end|start):/.test(l),
    );
    expect(physical).toEqual([]);
    const users = lines.filter((l) => /var\(--caption-inline-(end|start)/.test(l));
    expect(users.length).toBeGreaterThanOrEqual(4);
    for (const line of users) expect(line).toMatch(/^\s*(padding-inline|inset-inline-end):/);
  });

  it('isolates numbers and codes inside mixed-direction text', () => {
    const css = readFileSync(FILES['styles.css'], 'utf8');
    expect(css).toMatch(/\.mono[^{]*\{[^}]*unicode-bidi: isolate/);
  });
});
