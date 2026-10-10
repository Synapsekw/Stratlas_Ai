#!/usr/bin/env node
/* eslint-disable no-console -- lint script output */
// Lint the repository one workspace at a time, each in its own ESLint process. Typed linting of
// the whole repository in one process outgrows Node's heap (and the smaller CI runners); per
// workspace, memory stays bounded as the code grows. Extra arguments go to every ESLint run,
// e.g. `node tools/lint.mjs --fix`.
//
// Several of those processes run at once: one after another they took 8 min on a CI runner (63
// targets, run 38047000052). QUADRION_LINT_JOBS sets how many; by default half the cores, at most 4.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// The package does not export its bin path: take it from the manifest.
const require = createRequire(import.meta.url);
const manifest = require.resolve('eslint/package.json');
const { bin } = require(manifest);
const eslint = join(dirname(manifest), typeof bin === 'string' ? bin : bin.eslint);
const HEAP_MB = 4096;
const JOBS =
  Math.floor(Number(process.env.QUADRION_LINT_JOBS)) ||
  Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
const LINTED = /\.(ts|tsx|js|mjs|cjs)$/;

const dirs = (parent) =>
  existsSync(join(root, parent))
    ? readdirSync(join(root, parent))
        .map((n) => join(parent, n))
        .filter((p) => statSync(join(root, p)).isDirectory())
    : [];

const files = (dir) =>
  readdirSync(join(root, dir))
    .filter((n) => LINTED.test(n) && statSync(join(root, dir, n)).isFile())
    .map((n) => join(dir, n));

/**
 * An app carries several TypeScript programs (main, preload, renderer, tests): lint each part of
 * `src`, then its other folders, then its own files, so no run holds them all.
 */
const appParts = (app) => [
  ...dirs(join(app, 'src')),
  ...files(join(app, 'src')).map((f) => [f]),
  ...dirs(app).filter((d) => !/[\\/](src|node_modules|out|dist|demo)$/.test(d)),
  ...(files(app).length ? [files(app)] : []),
];

/** Workspaces first, then the other top-level folders with code, then the root's own files. */
const targets = [
  ...dirs('apps').flatMap(appParts),
  ...dirs('packages'),
  ...['tools', 'docs', 'python'].filter((d) => existsSync(join(root, d))),
];
const rootFiles = readdirSync(root).filter(
  (n) => LINTED.test(n) && statSync(join(root, n)).isFile(),
);

const extra = process.argv.slice(2);
// ESLint drops its colours when its output is a pipe (below): ask for them on a terminal.
const colour = process.stdout.isTTY ? ['--color'] : [];
const failed = [];

/** Lint one target; its output is printed in one piece when it ends, so runs do not interleave. */
const lint = (target) =>
  new Promise((resolve) => {
    const paths = Array.isArray(target) ? target : [target];
    const label = Array.isArray(target)
      ? target.length === 1
        ? String(target[0])
        : `${String(target.length)} files in ${relative(root, join(root, dirname(String(target[0])))) || '.'}`
      : relative(root, join(root, target));
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${String(HEAP_MB)}`,
        eslint,
        '--max-warnings',
        '0',
        '--no-warn-ignored',
        '--no-error-on-unmatched-pattern',
        ...colour,
        ...extra,
        ...paths,
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    let ended = false;
    const done = (ok) => {
      // a process that cannot start reports an error, and may still close
      if (ended) return;
      ended = true;
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      if (output.length) process.stdout.write(Buffer.concat(output));
      if (ok) console.log(`✓ ${label} (${secs} s)`);
      else {
        failed.push(label);
        console.error(`✖ ${label} (${secs} s)`);
      }
      resolve();
    };
    child.on('error', (error) => {
      output.push(Buffer.from(`${String(error)}\n`));
      done(false);
    });
    child.on('close', (code) => {
      done(code === 0);
    });
  });

const queue = [...targets, ...(rootFiles.length ? [rootFiles] : [])];
const worker = async () => {
  for (let target = queue.shift(); target !== undefined; target = queue.shift()) await lint(target);
};
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, worker));
if (failed.length) {
  console.error(`Lint failed in: ${failed.join(', ')}`);
  process.exit(1);
}
