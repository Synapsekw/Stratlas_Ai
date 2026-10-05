#!/usr/bin/env node
/* eslint-disable no-console -- lint script output */
// Lint the repository one workspace at a time, each in its own ESLint process. Typed linting of
// the whole repository in one process outgrows Node's heap (and the smaller CI runners); per
// workspace, memory stays bounded as the code grows. Extra arguments go to every ESLint run,
// e.g. `node tools/lint.mjs --fix`.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// The package does not export its bin path: take it from the manifest.
const require = createRequire(import.meta.url);
const manifest = require.resolve('eslint/package.json');
const { bin } = require(manifest);
const eslint = join(dirname(manifest), typeof bin === 'string' ? bin : bin.eslint);
const HEAP_MB = 4096;
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
const failed = [];
for (const target of [...targets, ...(rootFiles.length ? [rootFiles] : [])]) {
  const paths = Array.isArray(target) ? target : [target];
  const label = Array.isArray(target)
    ? target.length === 1
      ? String(target[0])
      : `${String(target.length)} files in ${relative(root, join(root, dirname(String(target[0])))) || '.'}`
    : relative(root, join(root, target));
  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${String(HEAP_MB)}`,
      eslint,
      '--max-warnings',
      '0',
      '--no-warn-ignored',
      '--no-error-on-unmatched-pattern',
      ...extra,
      ...paths,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  if (r.status !== 0) {
    failed.push(label);
    console.error(`✖ ${label} (${secs} s)`);
  } else console.log(`✓ ${label} (${secs} s)`);
}
if (failed.length) {
  console.error(`Lint failed in: ${failed.join(', ')}`);
  process.exit(1);
}
