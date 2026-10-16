import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER = join(import.meta.dirname, '..');

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) cssFiles(p, out);
    else if (e.name.endsWith('.css')) out.push(p);
  }
  return out;
}

describe('floating panels beside the sidebar', () => {
  it('sit off the live sidebar column (--sb-col), not its default widths', () => {
    // --sb-w and --sb-w-c are only the defaults: the sidebar can be dragged to 320 px.
    const offenders: string[] = [];
    for (const file of cssFiles(RENDERER)) {
      if (file.endsWith(`${sep}styles.css`)) continue; // the shell defines the column from them
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/var\(--sb-w(?:-c)?\)/.test(css)) offenders.push(relative(RENDERER, file));
    }
    expect(offenders).toEqual([]);
  });
});
