#!/usr/bin/env node
/**
 * Compare two runs of the agent eval (apps/desktop/e2e/agent-eval.spec.ts), or summarise one.
 *
 *   pnpm eval:agent:compare                       the two newest runs in .agent-eval/
 *   pnpm eval:agent:compare <before> <after>      two run folders (or single suite files)
 *   pnpm eval:agent:compare --summary [<run>]     one run's table (the newest by default)
 *   --dir <folder>                                where the runs are (default .agent-eval/)
 *
 * Prints per case what moved (fixed, broke, new, removed) and where the tool sequence changed,
 * then pass@1 and pass^k before and after. Exit 0 when it could compare, 2 on bad input. It
 * judges nothing itself: whether a broken case blocks a change is the reader's call.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareRuns,
  formatComparison,
  formatSummary,
  TRACE_SCHEMA,
} from '../../apps/desktop/e2e/agent-eval.trace.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DIR = process.env.QUADRION_EVAL_OUT ?? join(REPO, '.agent-eval');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    'usage: agent-eval-compare [--dir <folder>] [<before> <after>] | --summary [<run>]\n',
  );
  process.exit(2);
}

/** The suites of a run: a folder of suite files, or one suite file. */
function load(path) {
  if (!existsSync(path)) fail(`no trace at ${path}`);
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(path, f))
    : [path];
  const suites = files
    .map((f) => {
      try {
        return JSON.parse(readFileSync(f, 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((s) => s && s.schema === TRACE_SCHEMA);
  if (suites.length === 0) fail(`no trace in ${path}`);
  return suites;
}

/** Run folders in `dir`, newest last. */
function runs(dir) {
  if (!existsSync(dir)) fail(`no trace folder at ${dir}: run pnpm eval:agent first`);
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

const args = process.argv.slice(2);
let dir = DEFAULT_DIR;
const at = args.indexOf('--dir');
if (at >= 0) {
  dir = resolve(args[at + 1] ?? fail('--dir needs a folder'));
  args.splice(at, 2);
}
const summary = args.indexOf('--summary');
if (summary >= 0) {
  args.splice(summary, 1);
  const run = args[0] ? resolve(args[0]) : (runs(dir).at(-1) ?? fail(`no run in ${dir}`));
  process.stdout.write(`${basename(run)}\n\n`);
  for (const s of load(run)) process.stdout.write(`${formatSummary(s)}\n\n`);
  process.exit(0);
}

let before;
let after;
if (args.length === 2) [before, after] = args.map((a) => resolve(a));
else if (args.length === 0) {
  const all = runs(dir);
  if (all.length < 2) fail(`fewer than two runs in ${dir}`);
  [before, after] = all.slice(-2);
} else fail('give two runs, or none for the two newest');

process.stdout.write(`before: ${basename(before)}\nafter:  ${basename(after)}\n\n`);
process.stdout.write(`${formatComparison(compareRuns(load(before), load(after)))}\n`);
