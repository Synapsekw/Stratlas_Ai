#!/usr/bin/env node
/* eslint-disable no-console -- CI step output */
// The e2e spec files of one CI shard, split by how long each file takes (e2e-timings.json).
// Playwright's own --shard splits by test count, and the longest files sit together at the start
// of the alphabet: of three macOS shards the first ran 10.7 min of tests and the second 4.6
// (run 38051445110). By duration the same three come to about 7 min each.
//
//   node tools/ci/e2e-shards.mjs --shard 2/4        the files of shard 2 of 4, one per line
//   gh run view <run> --log | node tools/ci/e2e-shards.mjs --record
//                                                   rewrite e2e-timings.json from a CI run's log
//
// Every spec file is in exactly one shard, also a new one that has no timing yet (it counts as a
// file of median length). The timings only decide the balance, so they need a new --record now
// and then, not for every spec.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const here = fileURLToPath(new URL('.', import.meta.url));
export const E2E_DIR = join(here, '..', '..', 'apps', 'desktop', 'e2e');
export const TIMINGS_FILE = join(here, 'e2e-timings.json');

/** The spec files under `dir`, as Playwright names them (`e2e/<file>`, forward slashes), sorted. */
export function specFiles(dir = E2E_DIR) {
  return readdirSync(dir, { recursive: true })
    .map((f) => String(f).replace(/\\/g, '/'))
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => `e2e/${f}`)
    .sort();
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1;
};

/**
 * Split `files` into `total` shards of about equal duration: the longest file first, each to the
 * shard that is lightest so far. The same input always gives the same shards.
 *
 * @param {string[]} files
 * @param {Record<string, number>} timings seconds per file
 * @param {number} total
 * @returns {string[][]}
 */
export function assignShards(files, timings, total) {
  const unknown = median(files.filter((f) => f in timings).map((f) => timings[f]));
  const weight = (f) => timings[f] ?? unknown;
  const shards = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  const longestFirst = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
  for (const file of longestFirst) {
    const lightest = shards.reduce((a, b) => (b.seconds < a.seconds ? b : a));
    lightest.files.push(file);
    lightest.seconds += weight(file);
  }
  return shards.map((s) => s.files.sort());
}

/**
 * Seconds per spec file from the output of Playwright's list reporter, plain or as
 * `gh run view --log` prints it (job, step and time before each line). A file that ran in several
 * jobs (Windows and macOS) gets the mean.
 *
 * @param {string} log
 * @returns {Record<string, number>}
 */
export function parseTimings(log) {
  const perJob = new Map();
  for (const raw of log.split('\n')) {
    const line = stripVTControlCharacters(raw).trimEnd();
    // a skipped test has no duration: its file still counts, with nothing added
    const m = /e2e[\\/]([\w./\\-]+\.spec\.ts):\d+:\d+ .*?(?:\((\d+(?:\.\d+)?)(ms|s|m)\))?$/.exec(
      line,
    );
    if (!m) continue;
    const job = line.includes('\t') ? line.slice(0, line.indexOf('\t')) : '';
    const file = `e2e/${m[1].replace(/\\/g, '/')}`;
    const seconds = m[2] ? Number(m[2]) * { ms: 0.001, s: 1, m: 60 }[m[3]] : 0;
    const files = perJob.get(job) ?? new Map();
    files.set(file, (files.get(file) ?? 0) + seconds);
    perJob.set(job, files);
  }
  const sums = new Map();
  for (const files of perJob.values())
    for (const [file, seconds] of files) sums.set(file, [...(sums.get(file) ?? []), seconds]);
  return Object.fromEntries(
    [...sums]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([file, all]) => [
        file,
        Math.max(1, Math.round(all.reduce((a, b) => a + b, 0) / all.length)),
      ]),
  );
}

function cli() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--record') {
    const timings = parseTimings(readFileSync(0, 'utf8'));
    const count = Object.keys(timings).length;
    if (!count) throw new Error('No e2e test lines in the log on stdin.');
    writeFileSync(TIMINGS_FILE, `${JSON.stringify(timings, null, 2)}\n`);
    console.log(`${String(count)} spec files written to ${TIMINGS_FILE}`);
    return;
  }
  const m = /^(\d+)\/(\d+)$/.exec(argv[0] === '--shard' ? (argv[1] ?? '') : '');
  const [shard, total] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (!m || shard < 1 || shard > total)
    throw new Error('Usage: e2e-shards.mjs --shard <n>/<total> | --record');
  const timings = JSON.parse(readFileSync(TIMINGS_FILE, 'utf8'));
  const files = assignShards(specFiles(), timings, total)[shard - 1];
  // No file would make Playwright run every spec: fail instead.
  if (!files.length) throw new Error(`Shard ${argv[1]} has no spec file.`);
  console.log(files.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) cli();
