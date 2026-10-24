import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom lays nothing out, so the rules that fit the window's chart are read from the sheet
const css = readFileSync(join(import.meta.dirname, 'section.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};
/** An `@container` block, to its closing brace at the start of a line. */
const container = (query: string) => {
  const at = css.indexOf(`@container ${query}`);
  return at < 0 ? '' : css.slice(at, css.indexOf('\n}', at));
};

describe('the larger section window over a narrow stage (472 px with both sidebars open)', () => {
  it('lays itself out by its own width, not the window', () => {
    expect(rule('.sec-window')).toMatch(/container-type: inline-size/);
  });

  it('below 640 px the controls stack above a chart of the full width, the pins below', () => {
    expect(container('(max-width: 640px)')).toMatch(
      /\.sec-body\.big \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
    );
  });

  it('up to 960 px the pins go under the controls and the chart', () => {
    const mid = container('(max-width: 960px)');
    expect(mid).toMatch(
      /\.sec-body\.big \{[^}]*grid-template-columns: minmax\(160px, 200px\) minmax\(0, 1fr\)/,
    );
    expect(mid).toMatch(/\.sec-body\.big \.sec-pins \{[^}]*grid-column: 1 \/ -1/);
  });
});
