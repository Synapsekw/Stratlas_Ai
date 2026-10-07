// Performance budgets of the 1.0 checklist (docs/release/CHECKLIST-1.0.md, performance pass) and
// a small harness to hold code to them. The frame-time and Low-tier budgets of M7 stay in
// apps/desktop/e2e/perf.spec.ts; this file holds the M9 journal budgets and the release ones.
//
// The journal budgets run through an adapter, so the journal (T1) and merge (T4) streams plug in
// their real code without touching the test: export `journalBench` (a JournalBench) from
// packages/journal/src/bench.ts. Until then the reference adapter (journal-bench.reference.mjs)
// times the T0 primitives: seal, sign and append one line.

export const BUDGETS = Object.freeze({
  journal: Object.freeze({
    /** One op appended (seal, sign, write the segment line), 95th percentile. */
    appendP95Ms: 5,
    /** Opening a project with 100,000 ops from a snapshot, on top of the same open without. */
    open100kExtraMs: 1000,
    /** Merging 10,000 incoming ops (in a worker). */
    merge10kMs: 3000,
    /** Verify of 100,000 ops (background). */
    verify100kMs: 10_000,
  }),
  /** Start to first frame (PRD). Measured by the e2e startup check. */
  startupFirstFrameMs: 5000,
  /** Installer growth allowed over the M7 budget. */
  installerExtraBytes: 5 * 1024 * 1024,
});

/** The `p`th percentile (0 to 100) of `samples`, nearest rank. */
export function percentile(samples, p) {
  if (samples.length === 0) throw new Error('No samples.');
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Milliseconds each of `runs` calls of `fn` took, after `warmup` untimed calls. */
export async function sample(fn, runs, warmup = Math.min(20, runs)) {
  for (let i = 0; i < warmup; i++) await fn(i);
  const out = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn(warmup + i);
    out.push(performance.now() - t);
  }
  return out;
}

/** Milliseconds one call of `fn` took. */
export async function time(fn) {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

/**
 * @typedef {object} JournalBench
 * @property {string} name  Who provides it (shown in the test names).
 * @property {(dir: string) => Promise<(i: number) => Promise<void>>} [append]
 *   Ready a journal in `dir`; the answer appends op number `i`. It may carry `close()`, called
 *   after the run (an open segment handle).
 * @property {(dir: string, ops: number) => Promise<{ open: () => Promise<void>, baseline: () => Promise<void> }>} [open]
 *   Ready a project with `ops` ops and a snapshot; `open` opens it, `baseline` opens the same
 *   project without the journal.
 * @property {(dir: string, ops: number) => Promise<() => Promise<void>>} [merge]
 *   Ready `ops` incoming ops; the answer merges them.
 * @property {(dir: string, ops: number) => Promise<() => Promise<void>>} [verify]
 *   Ready a journal of `ops` ops; the answer verifies it.
 */

/**
 * Register the journal budget tests for `bench` (vitest's describe, it and expect). Timing
 * assertions run when `enforce` is true (STRATLAS_BUDGETS=1, nightly and the performance pass);
 * otherwise each check runs once at a small size, so the plumbing stays tested on every merge.
 */
export function journalBudgetTests({ describe, it, expect }, bench, o) {
  const { enforce, tempDir } = o;
  const b = BUDGETS.journal;
  const size = (full, small) => (enforce ? full : small);
  const skip = (fn) => (fn ? it : it.skip);

  describe(`journal budgets (${bench.name})`, () => {
    skip(bench.append)(
      `append: p95 under ${String(b.appendP95Ms)} ms`,
      async () => {
        const append = await bench.append(tempDir('append'));
        const ms = await sample(append, size(500, 20));
        await append.close?.();
        if (enforce) expect(percentile(ms, 95)).toBeLessThan(b.appendP95Ms);
      },
      120_000,
    );

    skip(bench.open)(
      `open 100k ops: under ${String(b.open100kExtraMs)} ms extra`,
      async () => {
        const { open, baseline } = await bench.open(tempDir('open'), size(100_000, 200));
        const extra = (await time(open)) - (await time(baseline));
        if (enforce) expect(extra).toBeLessThan(b.open100kExtraMs);
      },
      300_000,
    );

    skip(bench.merge)(
      `merge 10k ops: under ${String(b.merge10kMs)} ms`,
      async () => {
        const merge = await bench.merge(tempDir('merge'), size(10_000, 100));
        const ms = await time(merge);
        if (enforce) expect(ms).toBeLessThan(b.merge10kMs);
      },
      300_000,
    );

    skip(bench.verify)(
      `verify 100k ops: under ${String(b.verify100kMs)} ms`,
      async () => {
        const verify = await bench.verify(tempDir('verify'), size(100_000, 200));
        const ms = await time(verify);
        if (enforce) expect(ms).toBeLessThan(b.verify100kMs);
      },
      300_000,
    );
  });
}
