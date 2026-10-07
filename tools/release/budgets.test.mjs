// The 1.0 performance budgets (budgets.mjs). The journal budgets run against T1's bench when
// packages/journal/src/bench.ts exists, else against the reference bench. Timings are enforced
// with QUADRION_BUDGETS=1 (nightly and the performance pass); every merge runs them small.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BUDGETS,
  folderBytes,
  installerBudgetProblems,
  journalBudgetTests,
  packBudgetProblems,
  percentile,
  sample,
} from './budgets.mjs';
import { referenceBench } from './journal-bench.reference.mjs';
import { envVar } from '../../packages/brand/src/env.ts';

const t1Bench = fileURLToPath(new URL('../../packages/journal/src/bench.ts', import.meta.url));
const bench = existsSync(t1Bench)
  ? (await import(pathToFileURL(t1Bench).href)).journalBench
  : referenceBench;

const root = mkdtempSync(join(tmpdir(), 'aio-budgets-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('budget harness', () => {
  it('takes nearest-rank percentiles', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
    expect(() => percentile([], 95)).toThrow();
  });

  it('times calls after a warm-up', async () => {
    const seen = [];
    const ms = await sample((i) => seen.push(i), 5, 2);
    expect(ms).toHaveLength(5);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('holds the 1.0 numbers', () => {
    expect(BUDGETS.journal).toEqual({
      appendP95Ms: 5,
      open100kExtraMs: 1000,
      merge10kMs: 3000,
      verify100kMs: 10_000,
    });
    expect(BUDGETS.startupFirstFrameMs).toBe(5000);
  });
});

describe('size budgets (M10 decision 6)', () => {
  it('holds the pack and installer numbers', () => {
    expect(BUDGETS.pack).toEqual({ unpackedBytes: 1_100_000_000, compressedBytes: 450_000_000 });
    expect(BUDGETS.installer.growthOver090Bytes).toBe(15 * 1024 * 1024);
  });

  it('refuses a pack over either budget', () => {
    expect(packBudgetProblems({ unpackedBytes: 900e6, compressedBytes: 400e6 })).toEqual([]);
    expect(packBudgetProblems({ unpackedBytes: 900e6 })).toEqual([]);
    expect(packBudgetProblems({ unpackedBytes: 1.2e9, compressedBytes: 460e6 })).toEqual([
      'pack is 1200.0 MB unpacked, the budget is 1100.0 MB',
      'pack archive is 460.0 MB, the budget is 450.0 MB',
    ]);
  });

  it('refuses an installer more than 15 MB over its 0.9.0 baseline, reports one without', () => {
    const base = BUDGETS.installer.baseline090['win-x64-setup.exe'];
    const r = installerBudgetProblems([
      { name: 'Stratlas-0.10.0-win-x64-setup.exe', size: base + 10 * 1024 * 1024 },
      { name: 'Stratlas-0.10.0-mac-universal.dmg', size: 300e6 },
    ]);
    expect(r).toEqual({ problems: [], unchecked: ['Stratlas-0.10.0-mac-universal.dmg'] });
    const over = installerBudgetProblems([
      { name: 'Stratlas-0.10.0-win-x64-setup.exe', size: base + 16 * 1024 * 1024 },
    ]);
    expect(over.problems.join('')).toMatch(/16\.8 MB over 0\.9\.0, the budget allows 15\.7 MB/);
  });

  it('adds up a folder', () => {
    const dir = mkdtempSync(join(root, 'size-'));
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(1000));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.bin'), Buffer.alloc(24));
    expect(folderBytes(dir)).toBe(1024);
  });
});

journalBudgetTests({ describe, it, expect }, bench, {
  enforce: envVar(process.env, 'BUDGETS') === '1',
  tempDir: (name) => mkdtempSync(join(root, `${name}-`)),
});
