import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { E2E_DIR, TIMINGS_FILE, assignShards, parseTimings, specFiles } from './e2e-shards.mjs';

const timings = JSON.parse(readFileSync(TIMINGS_FILE, 'utf8'));
const files = specFiles();
const seconds = (shard, t = timings) => shard.reduce((a, f) => a + (t[f] ?? 0), 0);

describe('e2e shards', () => {
  it('puts every spec file in exactly one shard', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const total of [1, 2, 3, 4, 5, 6, 8]) {
      const shards = assignShards(files, timings, total);
      expect(shards).toHaveLength(total);
      expect(shards.flat().sort()).toEqual(files);
    }
  });

  it('gives the same shards whatever the order of the files', () => {
    const reversed = [...files].reverse();
    expect(assignShards(reversed, timings, 4)).toEqual(assignShards(files, timings, 4));
  });

  it('keeps the shards within 15 percent of the mean duration', () => {
    for (const total of [3, 4, 5]) {
      const shards = assignShards(files, timings, total).map((s) => seconds(s));
      const mean = shards.reduce((a, b) => a + b, 0) / total;
      expect(Math.max(...shards)).toBeLessThan(mean * 1.15);
    }
  });

  it('counts a file without a timing as one of median length', () => {
    const t = { 'e2e/a.spec.ts': 100, 'e2e/b.spec.ts': 60, 'e2e/c.spec.ts': 20 };
    const shards = assignShards([...Object.keys(t), 'e2e/new.spec.ts'], t, 2);
    // the new file counts as 60 s, like b: a (100) with c (20), b with the new file
    expect(shards).toEqual([
      ['e2e/a.spec.ts', 'e2e/c.spec.ts'],
      ['e2e/b.spec.ts', 'e2e/new.spec.ts'],
    ]);
  });

  it('covers every file Playwright would run in the e2e folder', () => {
    // playwright.config.ts keeps the default testMatch, which also takes *.test.ts and .js files
    const matched = readdirSync(E2E_DIR, { recursive: true })
      .map((f) => `e2e/${String(f).replace(/\\/g, '/')}`)
      .filter((f) => /\.(test|spec)\.(js|ts|mjs)$/.test(f))
      .sort();
    expect(matched).toEqual(files);
  });

  it('has every shard of each OS in the CI matrix', () => {
    const ci = readFileSync(
      fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
      'utf8',
    );
    expect(ci).toContain('tools/ci/e2e-shards.mjs --shard ${{ matrix.shard }}/${{ matrix.of }}');
    const rows = [...ci.matchAll(/- \{ os: (\S+), shard: (\d+), of: (\d+) \}/g)];
    const byOs = new Map();
    for (const [, os, shard, of] of rows) byOs.set(os, [...(byOs.get(os) ?? []), `${shard}/${of}`]);
    expect([...byOs.keys()].sort()).toEqual(['macos-latest', 'windows-latest']);
    for (const shards of byOs.values()) {
      const total = shards.length;
      const whole = Array.from({ length: total }, (_, i) => `${String(i + 1)}/${String(total)}`);
      expect([...shards].sort()).toEqual(whole);
    }
  });
});

describe('e2e timings from a log', () => {
  it('reads plain and gh-prefixed list reporter lines, on both systems', () => {
    const log = [
      '  ok  1 e2e\\a.spec.ts:10:1 › opens (1.5s)',
      '  ok  2 e2e\\a.spec.ts:20:1 › closes (500ms)',
      '  -   3 e2e\\b.spec.ts:5:1 › a project of the client @realdata',
      'e2e (macos-latest, 1/3)\tE2E\t2026-10-10T12:00:00.0000000Z   ✓  1 e2e/a.spec.ts:10:1 › opens (4.0s)',
      'e2e (macos-latest, 1/3)\tE2E\t2026-10-10T12:00:09.0000000Z   ✓  4 e2e/c.spec.ts:7:3 › a long one (1.2m)',
      'Running 4 tests using 1 worker',
    ].join('\n');
    // a.spec.ts: 2 s in one job and 4 s in the other; a file never drops to nothing
    expect(parseTimings(log)).toEqual({
      'e2e/a.spec.ts': 3,
      'e2e/b.spec.ts': 1,
      'e2e/c.spec.ts': 72,
    });
  });

  it('has a timing for every spec file, or the next --record is due', () => {
    const missing = files.filter((f) => !(f in timings));
    // new specs count as median files; refresh the timings when a third of the files are new
    expect(missing.length).toBeLessThan(files.length / 3);
  });
});
