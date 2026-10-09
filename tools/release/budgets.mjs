// Performance budgets of the 1.0 checklist (docs/release/CHECKLIST-1.0.md, performance pass) and
// a small harness to hold code to them. The frame-time and Low-tier budgets of M7 stay in
// apps/desktop/e2e/perf.spec.ts; this file holds the M9 journal budgets and the release ones.
//
// Size budgets of M10 decision 6, checked in CI after a build:
//   node tools/release/budgets.mjs --pack <pipeline-pack folder> [--archive <its .tar.gz>]
//   node tools/release/budgets.mjs --installers <apps/desktop/dist>
//
// The journal budgets run through an adapter, so the journal (T1) and merge (T4) streams plug in
// their real code without touching the test: export `journalBench` (a JournalBench) from
// packages/journal/src/bench.ts. Until then the reference adapter (journal-bench.reference.mjs)
// times the T0 primitives: seal, sign and append one line.

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

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
  /**
   * Pipeline pack 0.5.0 per platform (M10 decision 6): the unpacked folder and its archive. Over
   * budget, split a "photogrammetry" component pack rather than grow the base.
   */
  pack: Object.freeze({ unpackedBytes: 1_100_000_000, compressedBytes: 450_000_000 }),
  /**
   * Installer growth for CesiumJS and 3DTilesRendererJS over the 0.9.0 installer (M10 decision 6),
   * per installer file. The baseline is the 0.9.0 release build of each file; a platform without
   * a baseline is reported, not enforced.
   */
  installer: Object.freeze({
    growthOver090Bytes: 15 * 1024 * 1024,
    // The Windows installers as built for the 0.9.0 release (7 Oct 2026).
    baseline090: Object.freeze({
      'win-x64-setup.exe': 187_894_920,
      'win-x64-portable.exe': 176_679_186,
    }),
  }),
});

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/** Problems with a pipeline pack's size: `{ unpackedBytes, compressedBytes? }`. */
export function packBudgetProblems(size, budget = BUDGETS.pack) {
  const out = [];
  if (size.unpackedBytes > budget.unpackedBytes)
    out.push(
      `pack is ${mb(size.unpackedBytes)} unpacked, the budget is ${mb(budget.unpackedBytes)}`,
    );
  if (size.compressedBytes !== undefined && size.compressedBytes > budget.compressedBytes)
    out.push(
      `pack archive is ${mb(size.compressedBytes)}, the budget is ${mb(budget.compressedBytes)}`,
    );
  return out;
}

/**
 * Installer files (`{ name, size }`, such as Stratlas-0.10.0-win-x64-setup.exe) against the 0.9.0
 * baseline plus the allowed growth. Answers { problems, unchecked } (files with no baseline).
 */
export function installerBudgetProblems(files, budget = BUDGETS.installer) {
  const problems = [];
  const unchecked = [];
  for (const f of files) {
    const key = Object.keys(budget.baseline090).find((k) => f.name.endsWith(`-${k}`));
    if (!key) {
      unchecked.push(f.name);
      continue;
    }
    const growth = f.size - budget.baseline090[key];
    if (growth > budget.growthOver090Bytes)
      problems.push(
        `${f.name} is ${mb(f.size)}: ${mb(growth)} over 0.9.0, the budget allows ${mb(budget.growthOver090Bytes)}`,
      );
  }
  return { problems, unchecked };
}

/**
 * The allowance on the timing budgets (QUADRION_BUDGET_SCALE, at least 1). The budgets are for
 * release hardware; the nightly runs on shared runners with slower cores and a slow disk sync, so
 * it sets 1.5 (the smallest that clears their spread) and the performance pass on release hardware
 * runs 1.
 */
export function budgetScale(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

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
 * assertions run when `enforce` is true (QUADRION_BUDGETS=1, nightly and the performance pass);
 * otherwise each check runs once at a small size, so the plumbing stays tested on every merge.
 * `scale` (see budgetScale) multiplies every limit; the test names keep the 1.0 numbers.
 */
export function journalBudgetTests({ describe, it, expect }, bench, o) {
  const { enforce, tempDir, scale = 1 } = o;
  const b = BUDGETS.journal;
  const limit = (ms) => ms * scale;
  const size = (full, small) => (enforce ? full : small);
  const skip = (fn) => (fn ? it : it.skip);

  describe(`journal budgets (${bench.name})`, () => {
    skip(bench.append)(
      `append: p95 under ${String(b.appendP95Ms)} ms`,
      async () => {
        const append = await bench.append(tempDir('append'));
        const ms = await sample(append, size(500, 20));
        await append.close?.();
        if (enforce) expect(percentile(ms, 95)).toBeLessThan(limit(b.appendP95Ms));
      },
      120_000,
    );

    skip(bench.open)(
      `open 100k ops: under ${String(b.open100kExtraMs)} ms extra`,
      async () => {
        const { open, baseline } = await bench.open(tempDir('open'), size(100_000, 200));
        const extra = (await time(open)) - (await time(baseline));
        if (enforce) expect(extra).toBeLessThan(limit(b.open100kExtraMs));
      },
      300_000,
    );

    skip(bench.merge)(
      `merge 10k ops: under ${String(b.merge10kMs)} ms`,
      async () => {
        const merge = await bench.merge(tempDir('merge'), size(10_000, 100));
        const ms = await time(merge);
        if (enforce) expect(ms).toBeLessThan(limit(b.merge10kMs));
      },
      300_000,
    );

    skip(bench.verify)(
      `verify 100k ops: under ${String(b.verify100kMs)} ms`,
      async () => {
        const verify = await bench.verify(tempDir('verify'), size(100_000, 200));
        const ms = await time(verify);
        if (enforce) expect(ms).toBeLessThan(limit(b.verify100kMs));
      },
      300_000,
    );
  });
}

/** Total size of every file under `dir` (symbolic links not followed). */
export function folderBytes(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += folderBytes(p);
    else if (e.isFile()) total += statSync(p).size;
  }
  return total;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      pack: { type: 'string' },
      archive: { type: 'string' },
      installers: { type: 'string' },
    },
  });
  const problems = [];
  if (values.pack) {
    const size = {
      unpackedBytes: folderBytes(values.pack),
      compressedBytes: values.archive ? statSync(values.archive).size : undefined,
    };
    process.stdout.write(
      `pack: ${mb(size.unpackedBytes)} unpacked${size.compressedBytes === undefined ? '' : `, ${mb(size.compressedBytes)} archived`} (budget ${mb(BUDGETS.pack.unpackedBytes)} and ${mb(BUDGETS.pack.compressedBytes)})\n`,
    );
    problems.push(...packBudgetProblems(size));
  }
  if (values.installers) {
    const files = readdirSync(values.installers)
      .filter((n) => /-(setup|portable)\.exe$|\.dmg$/.test(n))
      .map((name) => ({ name, size: statSync(join(values.installers, name)).size }));
    const r = installerBudgetProblems(files);
    for (const f of files) process.stdout.write(`installer: ${f.name} ${mb(f.size)}\n`);
    for (const n of r.unchecked)
      process.stdout.write(`installer: ${n} has no 0.9.0 baseline; size reported, not enforced\n`);
    problems.push(...r.problems);
  }
  if (problems.length > 0) {
    process.stderr.write(`Size budget exceeded:\n  ${problems.join('\n  ')}\n`);
    process.exit(1);
  }
}
