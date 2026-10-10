import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

// ci.yml runs the Windows pytest suite in three parts chosen by file name (the pipelines job):
// tests/test_photo_chain.py, the other tests/test_photo_*.py, and everything else under tests.
describe('pytest parts of the pipelines job', () => {
  it('finds every test file directly in python/tests, named test_*.py', () => {
    // a test file in a subfolder named test_photo_* or ending in _test.py would be in no part
    const tests = readdirSync(repo('python/tests'), { recursive: true })
      .map((f) => String(f).replace(/\\/g, '/'))
      .filter((f) => !f.startsWith('.') && !f.includes('__pycache__'))
      .filter((f) => /(^|\/)test_[^/]*\.py$/.test(f) || /_test\.py$/.test(f));
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.filter((f) => f.includes('/') || !f.startsWith('test_'))).toEqual([]);
    expect(tests).toContain('test_photo_chain.py');
  });

  it('has the three Windows parts and the whole suite on macOS in the CI matrix', () => {
    const ci = readFileSync(repo('.github/workflows/ci.yml'), 'utf8');
    const rows = [...ci.matchAll(/- \{ os: (\S+), part: (\S+) \}/g)].map(
      ([, os, part]) => `${os} ${part}`,
    );
    expect(rows.sort()).toEqual([
      'macos-latest all',
      'windows-latest photo',
      'windows-latest photo-chain',
      'windows-latest rest',
    ]);
  });
});
