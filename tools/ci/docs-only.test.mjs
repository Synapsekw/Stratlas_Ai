import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { docsOnly, isDocPath } from './docs-only.mjs';

describe('docsOnly', () => {
  it('is true for docs and markdown files only', () => {
    expect(docsOnly(['docs/NORTH-STAR.md', 'docs/sessions/x.md'])).toBe(true);
    expect(docsOnly(['CLAUDE.md', '.claude/commands/wrapup.md', 'apps/desktop/README.md'])).toBe(
      true,
    );
    expect(docsOnly(['docs/architecture/diagram.svg', 'docs/plans/ROADMAP.md'])).toBe(true);
  });

  it('is false as soon as one path is not a document', () => {
    expect(docsOnly(['docs/a.md', 'apps/desktop/src/main.ts'])).toBe(false);
    expect(docsOnly(['.github/workflows/ci.yml'])).toBe(false);
    expect(docsOnly(['package.json'])).toBe(false);
    expect(docsOnly(['.claude/settings.json', 'CLAUDE.md'])).toBe(false);
  });

  it('is false for an empty list, so nothing is skipped by mistake', () => {
    expect(docsOnly([])).toBe(false);
    expect(docsOnly(['', '  '])).toBe(false);
  });

  it('does not take look-alikes for documents', () => {
    expect(isDocPath('mydocs/a.ts')).toBe(false);
    expect(isDocPath('apps/docs/a.ts')).toBe(false);
    expect(isDocPath('notes.md.ts')).toBe(false);
    expect(isDocPath('src/md')).toBe(false);
  });

  it('prints the step output', () => {
    const run = (input) =>
      execFileSync('node', ['tools/ci/docs-only.mjs'], { input, encoding: 'utf8' }).trim();
    expect(run('docs/a.md\nCLAUDE.md\n')).toBe('code=false');
    expect(run('docs/a.md\npython/uv.lock\n')).toBe('code=true');
    expect(run('')).toBe('code=true');
  });
});
