import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom lays nothing out, so the rules that give the pile list its height are read from the sheet
const css = readFileSync(join(import.meta.dirname, 'volumesView.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};

describe('the volumes view in a short bench (19 piles in 400 px)', () => {
  it('never squeezes the pile list: its rows take their content height and the view scrolls', () => {
    // a grid row of the fixed-height view shrank a clipped list to its 2 px of borders
    expect(rule('.vv')).toMatch(/grid-auto-rows: max-content/);
    // a scroll container has no content minimum in a grid: clip the corners without one
    expect(rule('.vv-piles')).not.toMatch(/overflow: (hidden|auto|scroll)/);
    expect(rule('.vv-piles')).toMatch(/overflow: clip/);
  });
});
