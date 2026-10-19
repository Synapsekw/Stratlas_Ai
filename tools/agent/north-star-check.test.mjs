import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { needsNorthStarBumpWarning } from './north-star-check.mjs';

const HOOK = fileURLToPath(new URL('./north-star-check.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'north-star-check-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('needsNorthStarBumpWarning', () => {
  it('warns when a plan or ADR changed without the north-star', () => {
    expect(needsNorthStarBumpWarning(['docs/plans/m11.md'])).toBe(true);
    expect(needsNorthStarBumpWarning(['docs\\architecture\\adr\\0007-x.md'])).toBe(true);
    expect(needsNorthStarBumpWarning(['src/x.ts', 'docs/plans/sub/p.md'])).toBe(true);
  });

  it('stays quiet when the north-star changed too, or nothing relevant changed', () => {
    expect(needsNorthStarBumpWarning(['docs/plans/m11.md', 'docs/NORTH-STAR.md'])).toBe(false);
    expect(needsNorthStarBumpWarning(['docs\\plans\\m11.md', 'docs\\NORTH-STAR.md'])).toBe(false);
    expect(needsNorthStarBumpWarning(['docs/architecture/SPEC.md', 'src/x.ts'])).toBe(false);
    expect(needsNorthStarBumpWarning(['docs/sessions/2026-10-10-0900-x.md'])).toBe(false);
    expect(needsNorthStarBumpWarning(['other/docs/plans/x.md'])).toBe(false);
    expect(needsNorthStarBumpWarning([])).toBe(false);
  });
});

describe('the Stop hook', () => {
  const hookEnv = { ...process.env };
  delete hookEnv.CLAUDE_PROJECT_DIR;
  // resolveRoot falls back to CLAUDE_PROJECT_DIR outside a repo; keep the real repo out of it.
  const runHook = (cwd, extra = {}) =>
    spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd, ...extra }),
      encoding: 'utf8',
      env: hookEnv,
      cwd,
    });

  it('warns through systemMessage, exits 0 and writes no session drafts', () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'docs', 'plans', 'p.md'), 'plan\n');
    for (let i = 0; i < 12; i += 1) writeFileSync(join(repo, `f${i}.txt`), 'x\n');

    const result = runHook(repo);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('docs/NORTH-STAR.md was not bumped');
    expect(readdirSync(join(repo, 'docs'))).toEqual(['plans']);

    writeFileSync(join(repo, 'docs', 'NORTH-STAR.md'), 'star\n');
    const quiet = runHook(repo);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe('');
  }, 30_000);

  it('stays silent when the stop hook is already active', () => {
    expect(runHook(join(dir, 'repo'), { stop_hook_active: true }).stdout).toBe('');
  });
});
