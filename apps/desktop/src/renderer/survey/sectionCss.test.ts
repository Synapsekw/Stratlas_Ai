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
    expect(rule('.sec-window')).toMatch(/container-type: size/);
  });

  it('below 640 px the controls stack above a chart of the full width, the pins below', () => {
    expect(container('(max-width: 640px)')).toMatch(
      /\.sec-body\.big \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
    );
  });

  it('up to 960 px the pins go under the controls and the chart', () => {
    const mid = container('(max-width: 960px)');
    // the controls' column wide enough for Previous, Section at stations and Next
    expect(mid).toMatch(
      /\.sec-body\.big \{[^}]*grid-template-columns: minmax\(220px, 260px\) minmax\(0, 1fr\)/,
    );
    expect(mid).toMatch(/\.sec-body\.big \.sec-pins \{[^}]*grid-column: 1 \/ -1/);
  });
});

describe('the larger section window docked on the stage', () => {
  it('sits at the bottom from the start edge, at most 880 px wide and 40 % high', () => {
    const w = rule('.sec-window');
    expect(w).toMatch(/inset-inline-start: var\(--sp-4\)/);
    expect(w).not.toMatch(/inset-inline:/);
    expect(w).toMatch(/inset-block-end: var\(--sp-4\)/);
    expect(w).toMatch(/max-inline-size: 880px/);
    expect(w).toMatch(/block-size: calc\(40% - var\(--sp-4\)\)/);
    // floating on the window (no stage), in the same proportion
    expect(rule('.sec-window.is-floating')).toMatch(/block-size: 40vh/);
  });

  it('scrolls its body, never the footer with the exports', () => {
    expect(rule('.sec-window')).toMatch(/overflow: hidden/);
    expect(rule('.sec-window > .sec-body.big')).toMatch(/overflow: auto/);
    expect(rule('.sec-foot')).toMatch(/flex: none/);
  });
});
