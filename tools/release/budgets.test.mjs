// The 1.0 performance budgets (budgets.mjs). The journal budgets run against T1's bench when
// packages/journal/src/bench.ts exists, else against the reference bench. Timings are enforced
// with STRATLAS_BUDGETS=1 (nightly and the performance pass); every merge runs them small.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BUDGETS, journalBudgetTests, percentile, sample } from './budgets.mjs';
import { referenceBench } from './journal-bench.reference.mjs';

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

journalBudgetTests({ describe, it, expect }, bench, {
  enforce: process.env.STRATLAS_BUDGETS === '1',
  tempDir: (name) => mkdtempSync(join(root, `${name}-`)),
});
