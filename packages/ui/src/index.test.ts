import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, SEVERITY_TOKENS } from './index';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

describe('Mission tokens', () => {
  it('defines every severity colour', () => {
    for (const t of SEVERITY_TOKENS) expect(css).toContain(`${t}:`);
  });

  it('defines surfaces, accent and fonts', () => {
    for (const t of ['--bg-0', '--bg-chrome', '--acc', '--f-ui', '--f-mono'])
      expect(css).toContain(`${t}:`);
  });

  it('matches the sidebar width in the CSS', () => {
    expect(css).toContain(`--sb-w: ${layout.sidebarWidth}px`);
    expect(css).toContain(`--sb-w-c: ${layout.sidebarCollapsedWidth}px`);
  });
});
