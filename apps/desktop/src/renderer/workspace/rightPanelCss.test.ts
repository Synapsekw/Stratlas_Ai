import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '../styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};

describe('the right panel until its divider is moved', () => {
  it('sizes a tall context from the whole panel, as before the split (cards above it count)', () => {
    // 62% of the split alone left the Changes list no height under the telecom card
    expect(rule('.right')).toMatch(/container-type: size/);
    expect(rule('.rp-split.auto .ctx-wrap.tall')).toMatch(/flex: 0 1 62cqh/);
    expect(rule('.rp-split.auto .ctx-wrap.tall.vol')).toMatch(/flex: 0 1 80cqh/);
    expect(rule('.ws.road .rp-split.auto .ctx-wrap.tall')).toMatch(/flex: 0 1 72cqh/);
  });
});
