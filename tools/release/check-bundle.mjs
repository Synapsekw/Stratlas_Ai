#!/usr/bin/env node
/* eslint-disable no-console -- release script output */
// Fails when the built main or preload bundle loads a package that the installed app does not
// ship (build-time tools such as sharp). Run from apps/desktop after `electron-vite build`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = ['sharp', 'jiti', 'vitest', '@playwright/test', 'electron-builder'];
const ROOTS = ['out/main', 'out/preload'];

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith('.js') || p.endsWith('.cjs') || p.endsWith('.mjs') ? [p] : [];
  });
}

/** True when `text` imports or requires `name` (or a subpath of it). */
export function loads(text, name) {
  const quoted = [`"${name}"`, `'${name}'`, `"${name}/`, `'${name}/`];
  return quoted.some((q) =>
    ['from ', 'from', 'require(', 'import('].some((prefix) => text.includes(prefix + q)),
  );
}

const problems = [];
for (const root of ROOTS) {
  for (const file of files(root)) {
    const text = readFileSync(file, 'utf8');
    for (const name of FORBIDDEN) {
      if (loads(text, name)) problems.push(`${file} loads "${name}"`);
    }
  }
}
if (problems.length) {
  console.error('Bundle check failed: the installed app would crash on start.');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`Bundle check passed (${ROOTS.join(', ')}).`);
