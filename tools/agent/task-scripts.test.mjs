import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs as parseStart } from './start-task.mjs';
import {
  baseRef,
  contractWarning,
  handoffMessage,
  parseArgs as parseFinish,
} from './finish-task.mjs';
import { parseArgs as parseWatch, summariseChecks } from './watch-ci.mjs';
import { findNames, forbiddenWords, isBinaryFile } from './check-public-text.mjs';

describe('check-public-text', () => {
  it('finds manifest names and the built-in list, line by line', () => {
    const words = forbiddenWords(['Northgate Quarry']);
    const text = 'fixed the legend\nsurvey of northgate quarry looks right\nDJI_0123 photo';
    expect(findNames(text, 'note.md', words)).toEqual([
      'note.md:2: Northgate Quarry',
      'note.md:3: DJI camera file name',
    ]);
    expect(findNames('Northgate Quarrying Ltd', 'x', forbiddenWords(['Quarry']))).toEqual([]);
  });

  it('treats images by extension and NUL-bearing files as binary, text as text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'public-text-'));
    const png = join(dir, 'shot.webp');
    const blob = join(dir, 'data.bin');
    const note = join(dir, 'note.md');
    writeFileSync(png, 'text-looking');
    writeFileSync(blob, Buffer.from([0x41, 0x00, 0x42]));
    writeFileSync(note, '# hello');
    expect(isBinaryFile(png)).toBe(true);
    expect(isBinaryFile(blob)).toBe(true);
    expect(isBinaryFile(note)).toBe(false);
  });
});

describe('start-task arguments', () => {
  it('defaults to a feat branch', () => {
    expect(parseStart(['map-legend'])).toEqual({
      name: 'map-legend',
      type: 'feat',
      branch: 'feat/map-legend',
    });
  });

  it('takes a branch type', () => {
    expect(parseStart(['--type', 'fix', 'tile-flake']).branch).toBe('fix/tile-flake');
  });

  it('refuses names that are not kebab-case and unknown types', () => {
    expect(parseStart(['Map_Legend']).error).toMatch(/kebab-case/);
    expect(parseStart([]).error).toMatch(/missing/);
    expect(parseStart(['x', '--type', 'wip']).error).toMatch(/--type/);
  });
});

describe('finish-task', () => {
  it('parses the modes', () => {
    expect(parseFinish([])).toEqual({ docs: false, rebase: true, cleanup: '' });
    expect(parseFinish(['--docs', '--no-rebase'])).toMatchObject({ docs: true, rebase: false });
    expect(parseFinish(['--cleanup', 'feat/x']).cleanup).toBe('feat/x');
    expect(parseFinish(['--cleanup']).error).toBeTruthy();
    expect(parseFinish(['--merge']).error).toBeTruthy();
  });

  it('warns when the schema changes without a contract-changes row', () => {
    expect(contractWarning(['packages/schema/src/ipc.ts'])).toMatch(/contract-changes/);
    expect(
      contractWarning(['packages/schema/src/ipc.ts', 'docs/architecture/contract-changes.md']),
    ).toBe('');
    expect(contractWarning(['apps/desktop/src/main/index.ts'])).toBe('');
  });

  it('writes the hand-off message the orchestrator expects', () => {
    const text = handoffMessage({
      branch: 'feat/map-legend',
      sha: 'abc1234',
      subjects: ['feat(desktop): a legend on the map'],
      checks: 'pnpm check',
      contract: false,
    });
    expect(text).toContain('feat/map-legend at abc1234');
    expect(text).toContain('Checks: pnpm check green');
    expect(text).toContain('Contract changes: none');
    expect(text).toMatch(/^E2E: /m);
    expect(text).toContain('rebased onto origin/main');
    expect(
      handoffMessage({ branch: 'b', sha: 's', subjects: [], checks: 'c', base: 'main' }),
    ).toContain('rebased onto main.');
  });

  it('rebases onto the local main while a merge batch is open', () => {
    expect(baseRef({ name: 'aio-software-f2', since: 'x', raw: '' })).toBe('main');
    expect(baseRef(null)).toBe('origin/main');
  });
});

describe('watch-ci', () => {
  it('parses branch and pr modes', () => {
    expect(parseWatch(['branch', 'main'])).toMatchObject({ mode: 'branch', maxSeconds: 1800 });
    expect(parseWatch(['pr', '44', '--interval', '10']).interval).toBe(10);
    expect(parseWatch(['pr', 'abc']).error).toBeTruthy();
    expect(parseWatch(['tag', 'v1']).error).toBeTruthy();
  });

  it('summarises PR checks', () => {
    expect(summariseChecks([]).state).toBe('none');
    expect(summariseChecks([{ bucket: 'pass' }, { bucket: 'pending' }]).state).toBe('pending');
    expect(summariseChecks([{ bucket: 'pass' }, { bucket: 'skipping' }]).state).toBe('green');
    expect(summariseChecks([{ bucket: 'pass' }, { bucket: 'cancel' }]).state).toBe('failed');
  });
});
