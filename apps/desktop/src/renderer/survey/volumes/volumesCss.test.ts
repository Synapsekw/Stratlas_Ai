import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom lays nothing out, so the rules that keep the inventory inside the panel are read from the
// sheet (the real widths are checked in e2e/volumes-tab.spec.ts at a 1100 px window)
const css = readFileSync(join(import.meta.dirname, 'volumes.css'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};
/** An `@container` block, to its closing brace at the start of a line. */
const container = (query: string) => {
  const at = css.indexOf(`@container ${query}`);
  return at < 0 ? '' : css.slice(at, css.indexOf('\n}', at));
};

describe('the inventory table in the docked panel (no sideways scroll at its default width)', () => {
  it('a figure never breaks', () => {
    expect(rule('.vi-table td')).toMatch(/white-space: nowrap/);
  });

  it('a name wraps inside its column, so the table is never wider than its box', () => {
    const name = rule('.vi-table .vi-name');
    expect(name).toMatch(/white-space: normal/);
    // a name of one long word breaks too, and counts as narrow when the columns are sized
    expect(name).toMatch(/overflow-wrap: anywhere/);
  });

  it('a group’s name gives way and its density stays whole', () => {
    expect(rule('.vi-gname')).toMatch(/min-width: 0/);
    expect(rule('.vi-dens')).toMatch(/white-space: nowrap/);
  });

  it('nothing in the inventory is cut off or scrolled', () => {
    for (const selector of ['.vi', '.vi-table', '.vi-table .vi-name', '.vi-gname', '.vi-dens']) {
      expect(rule(selector), selector).not.toBe('');
      expect(rule(selector), selector).not.toMatch(/overflow(-x|-inline)?:|text-overflow/);
    }
  });

  it('lays itself out by its own width and sits closer in a narrow panel', () => {
    expect(rule('.vi')).toMatch(/container: vinv \/ inline-size/);
    const narrow = container('vinv (max-width: 400px)');
    expect(narrow).toMatch(/\.vi-table td \{[^}]*padding-inline: var\(--sp-2\)/);
    expect(narrow).toMatch(/\.vi-pile \.vi-name \{[^}]*padding-inline-start:/);
  });
});
