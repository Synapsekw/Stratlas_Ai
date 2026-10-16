import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '../parts/split.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const transitions = [...css.matchAll(/transition(?:-property)?\s*:\s*([^;}]+)/g)].map((m) =>
  (m[1] ?? '').trim(),
);

describe('split.css motion', () => {
  it('animates only opacity and transform, never tracks, insets or sizes', () => {
    expect(transitions.length).toBeGreaterThan(0);
    for (const value of transitions) {
      if (value === 'none') continue;
      const props = value.split(',').map((part) => part.trim().split(/\s+/)[0]);
      for (const prop of props) expect(['opacity', 'transform']).toContain(prop);
    }
  });

  it('takes its durations from the motion tokens', () => {
    // only the 150 ms hover delay is a literal time
    for (const value of transitions) expect(value).not.toMatch(/\b\d+m?s\b/);
    expect(css).not.toMatch(/transition-duration\s*:\s*\d/);
  });
});
